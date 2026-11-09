// Verlet integration and structural/shear/bend constraints adapted from
// Dmitry Kurash's Holocloth (MIT), src/cloth.ts at
// a6078ba698a53cbf18be870cea555c1971f84103. See cloth-LICENSE.txt.
// This sheet uses pinned overscan edges and a moving, soft pull over the mesh.

export const CLOTH_PERSPECTIVE = .34;
const STEP = 1 / 120;
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
        this.rest.set([u, v, 0], i * 3);
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
    this.settleTime = 0;
    this.updateSurface();
  }

  startGrab(x, y) {
    this.grab = { x, y, targetX: x, targetY: y, slipX: 0, slipY: 0,
      axisX: 1, axisY: 0, lift: 0, load: 0 };
  }

  moveGrab(x, y, load, spin) {
    const grab = this.grab;
    if (!grab) return;
    // Rotation lets the fabric slip tangentially beneath the pointer. Measure
    // in short-edge units so the offset is comparable on touch and desktop.
    const slip = clamp(spin * .038, -.15, .15) / Math.max(.14, Math.hypot(x, y));
    grab.slipX = -y * slip;
    grab.slipY = x * slip;
    grab.targetX = x - grab.slipX;
    grab.targetY = y - grab.slipY;
    grab.load = load;
  }

  endGrab() {
    this.grab = null;
    this.settleTime = 1;
  }

  step(dt) {
    if (!this.grab && this.settleTime <= 0) return;
    this.accumulator += Math.min(Math.max(0, dt), 4 * STEP);
    let steps = 0;
    while (this.accumulator >= STEP && steps < 4) {
      this.substep();
      this.accumulator -= STEP;
      steps++;
    }
    if (!this.grab) {
      this.settleTime -= steps * STEP;
      if (this.settleTime <= 0) {
        this.reset();
        return;
      }
    }
    if (steps) this.updateSurface();
  }

  substep() {
    const p = this.positions;
    const rest = this.rest;
    const prev = this.previous;
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
    }

    if (this.grab) this.applyGrab(this.grab);
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
    }
  }

  applyGrab(grab) {
    const gapX = grab.targetX - grab.x, gapY = grab.targetY - grab.y;
    grab.x += gapX * .052;
    grab.y += gapY * .052;
    grab.lift += (.074 + .15 * grab.load - grab.lift) * .15;

    const pullX = (gapX + grab.slipX) * .52;
    const pullY = (gapY + grab.slipY) * .52;
    const pull = Math.hypot(pullX, pullY);
    if (pull > .004) {
      // A half turn in the axis would describe the same ellipse. Keeping the
      // closer direction makes the footprint ease through a reversal.
      const sign = pullX * grab.axisX + pullY * grab.axisY < 0 ? -1 : 1;
      grab.axisX += (sign * pullX / pull - grab.axisX) * .22;
      grab.axisY += (sign * pullY / pull - grab.axisY) * .22;
      const length = Math.hypot(grab.axisX, grab.axisY);
      grab.axisX /= length;
      grab.axisY /= length;
    }
    const reach = .26 + .095 * grab.load + Math.min(.17, pull * .85);
    const breadth = .19 + .065 * grab.load;
    const travel = Math.min(1, .14 / Math.max(.001, pull));
    const gather = .22 + .26 * grab.load;
    const p = this.positions;
    // A tapered spring acts on whichever vertices are in reach this step.
    // Vertices leaving the patch carry their momentum into the next fold.
    for (let i = 0; i < this.count; i++) {
      const mobility = this.mobility[i];
      if (!mobility) continue;
      const k = i * 3;
      const dx = this.rest[k] - grab.x, dy = this.rest[k + 1] - grab.y;
      if (Math.abs(dx) > reach || Math.abs(dy) > reach) continue;
      const along = (dx * grab.axisX + dy * grab.axisY) / reach;
      const across = (dy * grab.axisX - dx * grab.axisY) / breadth;
      const falloff = 1 - along * along - across * across;
      if (falloff <= 0) continue;
      const spring = .085 * falloff * falloff * mobility;
      const crease = 1 - .64 * Math.abs(across);
      p[k] += (this.rest[k] + pullX * travel - dx * gather - p[k]) * spring;
      p[k + 1] += (this.rest[k + 1] + pullY * travel - dy * gather - p[k + 1]) * spring;
      p[k + 2] += (grab.lift * crease - p[k + 2]) * spring;
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
