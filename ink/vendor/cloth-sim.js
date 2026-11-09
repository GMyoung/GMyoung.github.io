// Verlet integration, structural/shear/bend constraints and weighted grip
// adapted from Dmitry Kurash's Holocloth (MIT), src/cloth.ts at
// a6078ba698a53cbf18be870cea555c1971f84103. See cloth-LICENSE.txt.
// This viewport-sized sheet uses pinned overscan edges and a draped rest pose.

export const CLOTH_PERSPECTIVE = .34;
const STEP = 1 / 120;
const GRAB_RADIUS = .145;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export class ClothMesh {
  constructor(span, segments) {
    this.span = span;
    this.segments = segments;
    this.cols = segments + 1;
    this.count = this.cols ** 2;
    this.spacing = span / segments;
    this.positions = new Float32Array(this.count * 3);
    this.rest = new Float32Array(this.positions.length);
    this.previous = new Float32Array(this.positions.length);
    this.material = new Float32Array(this.count * 2);
    this.surface = new Float32Array(this.count * 4);
    this.mobility = new Float32Array(this.count);
    this.indices = new Uint16Array(segments * segments * 6);
    const links = [];
    const index = (x, y) => y * this.cols + x;
    let face = 0;
    for (let y = 0; y <= segments; y++) {
      for (let x = 0; x <= segments; x++) {
        const i = index(x, y);
        const u = x * this.spacing - span / 2;
        const v = y * this.spacing - span / 2;
        this.material.set([u, v], i * 2);
        const drape = .049 * Math.sin(u * 8.5 + v * 2.8 + .85 * Math.sin(v * 4))
          + .024 * Math.sin(v * 13.2 - u * 4.1) + .033 * Math.cos(v * 4.8 + u * 1.6);
        this.rest.set([u, v, drape], i * 3);
        this.mobility[i] = clamp(Math.min(x, y, segments - x, segments - y) / 2, 0, 1);
        if (x < segments) links.push([i, i + 1, 1]);
        if (y < segments) links.push([i, i + this.cols, 1]);
        if (x < segments && y < segments) {
          const next = i + this.cols;
          links.push([i, next + 1, .82], [i + 1, next, .82]);
          this.indices.set([i, i + 1, next, i + 1, next + 1, next], face);
          face += 6;
        }
        if (x + 2 <= segments) links.push([i, i + 2, .22]);
        if (y + 2 <= segments) links.push([i, i + 2 * this.cols, .22]);
      }
    }
    this.cA = new Uint16Array(links.length);
    this.cB = new Uint16Array(links.length);
    this.cRest = new Float32Array(links.length);
    this.cStrength = new Float32Array(links.length);
    links.forEach(([a, b, strength], i) => {
      this.cA[i] = a;
      this.cB[i] = b;
      this.cStrength[i] = .92 * strength;
      this.cRest[i] = Math.hypot(this.rest[a * 3] - this.rest[b * 3],
        this.rest[a * 3 + 1] - this.rest[b * 3 + 1], this.rest[a * 3 + 2] - this.rest[b * 3 + 2]);
    });
    this.reset();
  }

  reset() {
    this.positions.set(this.rest);
    this.previous.set(this.rest);
    this.grab = null;
    this.accumulator = 0;
    this.updateSurface();
  }

  startGrab(x, y) {
    const p = this.positions;
    let nearest = -1;
    let distance = Infinity;
    for (let i = 0; i < this.count; i++) {
      if (this.mobility[i] === 0) continue;
      const k = i * 3;
      const scale = 1 / (1 - CLOTH_PERSPECTIVE * p[k + 2]);
      const dx = p[k] * scale - x;
      const dy = p[k + 1] * scale - y;
      const d = dx * dx + dy * dy;
      if (d < distance) { nearest = i; distance = d; }
    }
    if (nearest < 0) return;
    const at = nearest * 3;
    const cx = p[at], cy = p[at + 1], cz = p[at + 2];
    const scale = 1 / (1 - CLOTH_PERSPECTIVE * cz);
    const nodes = [];
    for (let i = 0; i < this.count; i++) {
      if (!this.mobility[i]) continue;
      const k = i * 3;
      const dx = p[k] - cx, dy = p[k + 1] - cy, dz = p[k + 2] - cz;
      const t = 1 - Math.sqrt(dx * dx + dy * dy + dz * dz) / GRAB_RADIUS;
      if (t <= 0) continue;
      nodes.push({ k, dx, dy, dz, weight: t * t * (3 - 2 * t) * this.mobility[i] });
    }
    this.grab = { nodes, offsetX: cx * scale - x, offsetY: cy * scale - y,
      baseZ: cz, x, y, z: cz, lift: 0, load: 0 };
  }

  moveGrab(x, y, load) {
    if (!this.grab) return;
    this.grab.x = x;
    this.grab.y = y;
    this.grab.load = load;
  }

  endGrab() { this.grab = null; }

  step(dt, time) {
    this.accumulator += Math.min(Math.max(0, dt), 4 * STEP);
    let steps = 0;
    while (this.accumulator >= STEP && steps < 4) {
      this.substep(time);
      this.accumulator -= STEP;
      steps++;
    }
    if (steps) this.updateSurface();
  }

  substep(time) {
    const p = this.positions;
    const rest = this.rest;
    const prev = this.previous;
    const air = Math.sin(time * .93) * .00023;
    for (let i = 0; i < this.count; i++) {
      const mobility = this.mobility[i];
      if (mobility === 0) continue;
      const at = i * 3;
      const returning = .009 + (1 - mobility) * .16;
      for (let channel = 0; channel < 3; channel++) {
        const k = at + channel;
        const current = p[k];
        p[k] = current + (current - prev[k]) * .91 + (rest[k] - current) * returning;
        prev[k] = current;
      }
      p[at + 2] += air * Math.cos(rest[at] * 3.2 + rest[at + 1] * 2.1);
    }

    const g = this.grab;
    if (g) {
      g.lift += (.105 + .13 * g.load - g.lift) * .18;
      g.z = clamp(g.baseZ + g.lift, -.16, .38);
    }
    for (let iteration = 0; iteration < 5; iteration++) {
      for (let c = 0; c < this.cA.length; c++) {
        const a = this.cA[c], b = this.cB[c];
        const ia = a * 3, ib = b * 3;
        const wa = this.mobility[a], wb = this.mobility[b];
        if (!(wa + wb)) continue;
        const dx = p[ib] - p[ia], dy = p[ib + 1] - p[ia + 1], dz = p[ib + 2] - p[ia + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < 1e-7) continue;
        const diff = ((d - this.cRest[c]) / d) * this.cStrength[c] / (wa + wb);
        p[ia] += dx * diff * wa; p[ia + 1] += dy * diff * wa; p[ia + 2] += dz * diff * wa;
        p[ib] -= dx * diff * wb; p[ib + 1] -= dy * diff * wb; p[ib + 2] -= dz * diff * wb;
      }
      if (g) this.applyGrab(g);
    }
  }

  applyGrab(g) {
    const p = this.positions;
    const depth = 1 - CLOTH_PERSPECTIVE * g.z;
    const x = (g.x + g.offsetX) * depth;
    const y = (g.y + g.offsetY) * depth;
    // Pull specific vertices together at the contact so the surplus length
    // buckles into the surrounding cloth. UVs never move between vertices.
    const pinch = 1 - clamp(g.lift * 2.35, 0, .57);
    for (const { k, dx, dy, dz, weight } of g.nodes) {
      const hold = .80 * weight;
      p[k] += (x + dx * pinch - p[k]) * hold;
      p[k + 1] += (y + dy * pinch - p[k + 1]) * hold;
      p[k + 2] += (g.z + dz - p[k + 2]) * hold;
    }
  }

  updateSurface() {
    const p = this.positions;
    const n = this.surface;
    for (let i = 0; i < this.count; i++) {
      const x = i % this.cols, y = Math.floor(i / this.cols);
      const l = (x ? i - 1 : i) * 3, r = (x < this.segments ? i + 1 : i) * 3;
      const u = (y ? i - this.cols : i) * 3, d = (y < this.segments ? i + this.cols : i) * 3;
      const ax = p[r] - p[l], ay = p[r + 1] - p[l + 1], az = p[r + 2] - p[l + 2];
      const bx = p[d] - p[u], by = p[d + 1] - p[u + 1], bz = p[d + 2] - p[u + 2];
      const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
      const at = i * 4, k = i * 3;
      n[at] = length > 1e-7 ? nx / length : 0;
      n[at + 1] = length > 1e-7 ? ny / length : 0;
      n[at + 2] = length > 1e-7 ? nz / length : 1;
      const lx = (p[l] + p[r] + p[u] + p[d]) * .25 - p[k];
      const ly = (p[l + 1] + p[r + 1] + p[u + 1] + p[d + 1]) * .25 - p[k + 1];
      const lz = (p[l + 2] + p[r + 2] + p[u + 2] + p[d + 2]) * .25 - p[k + 2];
      n[at + 3] = clamp((lx * n[at] + ly * n[at + 1] + lz * n[at + 2]) * 7.2 / this.spacing, 0, 1);
    }
  }
}
