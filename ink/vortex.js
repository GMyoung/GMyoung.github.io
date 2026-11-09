import { ClothMesh, CLOTH_PERSPECTIVE } from './vendor/cloth-sim.js?v=1.17.0';

const TAU = Math.PI * 2;
const TEXTURE = 256;
const MARK_TEXTURE = 512;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const smoothstep = (a, b, value) => {
  const t = clamp((value - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

const paintInterface = precision => `
uniform ${precision} vec2 u_resolution;
uniform ${precision} float u_angle;
varying ${precision} vec2 v_material;
varying mediump vec4 v_surface;
`;

const vertexSource = `
attribute vec3 a_position;
attribute vec4 a_surface;
attribute vec2 a_material;
uniform vec2 u_shift;

void main() {
  float c = cos(u_angle);
  float s = sin(u_angle);
  mat2 spin = mat2(c, s, -s, c);
  float edge = min(u_resolution.x, u_resolution.y);
  float w = 1.0 - a_position.z * ${CLOTH_PERSPECTIVE};
  vec2 projected = (spin * a_position.xy * edge + u_shift * w) * 2.0 / u_resolution;
  gl_Position = vec4(projected.x, -projected.y, -a_position.z * 0.85, w);
  v_material = a_material;
  v_surface = vec4(spin * a_surface.xy, a_surface.zw);
}`;

// The original paint is evaluated in material coordinates. It follows the
// vertices through every fold, along with the brush fragments printed on it.
const fragmentBody = `
uniform float u_time;
uniform float u_velocity;
uniform float u_progress;
uniform float u_energy;
uniform float u_markSpan;
uniform float u_markOpacity;
uniform sampler2D u_marks;

void main() {
  float edge = min(u_resolution.x, u_resolution.y);
  float pixel = max(1.0, edge / 570.0);
  vec2 pixelOffset = mod(gl_FragCoord.xy, pixel) * vec2(-1.0, 1.0) / edge;
  float c = cos(u_angle);
  float s = sin(u_angle);
  vec2 material = v_material + mat2(c, -s, s, c) * pixelOffset;
  vec2 p = material;
  float drift = u_time * 0.08;
  float energy = u_energy;
  p += 0.085 * vec2(sin(drift * 2.0), cos(drift * 3.0));
  p *= 1.0 + 0.045 * sin(drift);
  float radius = length(p);
  float polar = radius < 0.00001 ? 0.0 : atan(p.y, p.x);
  polar -= radius * (5.2 + energy * 0.8 + abs(u_velocity) * 0.032);
  polar -= 0.25 * sin(radius * 5.0 - drift * 4.0);
  vec2 q = radius * vec2(cos(polar), sin(polar)) * 2.8;
  for (int i = 0; i < 3; i++) {
    float layer = float(i);
    q += (0.34 - layer * 0.05) * vec2(
      sin(q.y * 1.6 + layer * 1.8 + drift * 4.0),
      cos(q.x * 1.9 - layer * 0.9 - drift * 3.0)
    );
  }
  float field = sin(q.x * 3.2 + sin(q.y * 1.6 + drift * 2.0))
              + 0.65 * cos(q.y * 2.7 - q.x * 0.6 - drift * 3.0);
  float band = smoothstep(-0.10, 0.65, field);
  float dark = smoothstep(0.80, 1.35, field);
  float filament = sin(field * (7.0 + energy * 6.0) + q.x * 1.5 - q.y * 1.8 + drift * 4.0);
  float veins = smoothstep(0.48, 0.90, filament) * band;
  float edgeLight = 1.0 - smoothstep(0.02, 0.18, abs(field - 0.28));
  vec3 yellow = mix(vec3(1.0, 0.875, 0.015), vec3(1.0, 0.93, 0.18), energy);
  vec3 pollen = mix(vec3(0.69, 0.73, 0.08), vec3(0.78, 0.84, 0.15), energy);
  vec3 green = mix(vec3(0.17, 0.39, 0.10), vec3(0.29, 0.55, 0.13), energy);
  vec3 color = mix(yellow, pollen, band * 0.78);
  color = mix(color, green, dark * 0.82);
  color = mix(color, green, veins * (0.10 + energy * 0.22));
  float glow = edgeLight * (0.10 + energy * 0.42) + veins * (0.025 + energy * 0.16);
  color = mix(color, vec3(1.0, 0.97, 0.47), clamp(glow, 0.0, 0.65));
  float grain = fract(sin(dot(floor(material * edge * 0.5) * 0.01, vec2(17.1, 61.7))) * 971.3);
  color *= 0.989 + grain * (0.019 + u_progress * 0.003);
  vec2 markUV = v_material / u_markSpan + 0.5;
  vec4 mark = texture2D(u_marks, markUV);
  color = color * (1.0 - mark.a * u_markOpacity) + mark.rgb * u_markOpacity;

  // A flat sheet leaves the old paint colors untouched. Only slopes and
  // cavities made by the moving folds catch light.
  vec3 normal = normalize(v_surface.xyz);
  if (normal.z < 0.0) normal = -normal;
  float light = 1.0 + 0.23 * dot(normal.xy, vec2(-0.70, -0.48))
    - 0.09 * (1.0 - normal.z) - 0.14 * v_surface.w;
  gl_FragColor = vec4(color * clamp(light, 0.78, 1.16), 1.0);
}`;

function makeCanvas() {
  const canvas = document.createElement('canvas');
  canvas.className = 'intro-vortex-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  return canvas;
}

function drawMarks(ctx, radius, span, time, progress, focused, still) {
  const side = MARK_TEXTURE;
  const unit = side / span;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, side, side);
  ctx.setTransform(unit, 0, 0, unit, side / 2, side / 2);
  const size = clamp(radius / 112, .52, 1);
  const gather = 1 - progress * .3;
  for (let i = 0; i < 16; i++) {
    const orbit = i * .79 + Math.sin(i * 1.7) * .32;
    const distance = radius * (.30 + i / 15 * 1.25) * gather;
    const amplitude = (12 + i % 5 * 3) * Math.max(.75, size);
    const driftX = still ? 0 : Math.sin(time * (.43 + i % 3 * .08) + i * 1.9) * amplitude;
    const driftY = still ? 0 : Math.cos(time * (.51 + i % 4 * .06) + i * 2.1) * amplitude * .84;
    const tumble = still ? 0 : Math.sin(time * .46 + i * .9) * .18 + Math.cos(time * .71 + i * 1.2) * .09;
    const x = Math.cos(orbit) * distance + Math.sin(i * 2.4) * radius * .14 + driftX;
    const y = Math.sin(orbit) * distance * .81 + Math.cos(i * 1.3) * radius * .10 + driftY;
    const length = (15 + (i % 4) * 8 + Math.sin(i * 2) * 3) * size;
    const width = (i % 3 === 2 ? 2.5 : 5 + i % 4 * 1.8) * size;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(orbit + .55 + Math.sin(i * 2.8) * .8 + tumble);
    ctx.fillStyle = `rgb(${44 + i % 3 * 6},${Math.round(96 + progress * 31 + i % 3 * 9)},${25 + i % 4 * 4})`;
    ctx.beginPath();
    if (i % 3 === 1) {
      ctx.moveTo(-length * .5, -width * .46);
      ctx.quadraticCurveTo(length * .12, -width * .65, length * .53, width * .20);
      ctx.lineTo(length * .30, width * .18);
      ctx.lineTo(length * .48, width * .40);
      ctx.quadraticCurveTo(-length * .1, width * .54, -length * .5, width * .40);
    } else {
      ctx.moveTo(-length * .5, -width * .32);
      ctx.lineTo(-length * .30, -width * .54);
      ctx.lineTo(length * .48, -width * .31);
      ctx.lineTo(length * .53, width * .29);
      ctx.lineTo(length * .31, width * .46);
      ctx.lineTo(-length * .47, width * .40);
    }
    ctx.closePath();
    ctx.fill();
    if (focused) {
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = '#234414';
      ctx.stroke();
    }
    ctx.clip();
    ctx.lineWidth = Math.max(.5, size * .7);
    for (let fiber = 0; fiber < 7; fiber++) {
      const line = (fiber / 6 - .5) * width;
      ctx.strokeStyle = fiber % 3 ? '#cbdd7f50' : '#183e1050';
      ctx.beginPath();
      ctx.moveTo(-length * .48 + Math.sin(fiber + i) * 3 * size, line);
      ctx.lineTo(length * (.20 + fiber % 3 * .12), line + Math.sin(fiber * 2.4 + i) * 1.7 * size);
      ctx.stroke();
    }
    ctx.restore();
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function bakePaint(span, energy) {
  const out = new Uint8ClampedArray(TEXTURE * TEXTURE * 3);
  for (let y = 0; y < TEXTURE; y++) {
    for (let x = 0; x < TEXTURE; x++) {
      const px = (x / (TEXTURE - 1) - .5) * span;
      const py = (y / (TEXTURE - 1) - .5) * span + .085;
      const r = Math.hypot(px, py);
      const theta = Math.atan2(py, px) - r * (5.2 + energy * .8) - .25 * Math.sin(r * 5);
      let qx = r * Math.cos(theta) * 2.8;
      let qy = r * Math.sin(theta) * 2.8;
      for (let i = 0; i < 3; i++) {
        const amplitude = .34 - i * .05;
        const nx = qx + amplitude * Math.sin(qy * 1.6 + i * 1.8);
        qy += amplitude * Math.cos(qx * 1.9 - i * .9);
        qx = nx;
      }
      const field = Math.sin(qx * 3.2 + Math.sin(qy * 1.6)) + .65 * Math.cos(qy * 2.7 - qx * .6);
      const band = smoothstep(-.1, .65, field);
      const dark = smoothstep(.8, 1.35, field) * .82;
      const veins = smoothstep(.48, .9, Math.sin(field * (7 + energy * 6) + qx * 1.5 - qy * 1.8)) * band;
      const glow = (1 - smoothstep(.02, .18, Math.abs(field - .28))) * (.10 + energy * .42)
        + veins * (.025 + energy * .16);
      const yellow = [1, .875 + .055 * energy, .015 + .165 * energy];
      const pollen = [.69 + .09 * energy, .73 + .11 * energy, .08 + .07 * energy];
      const green = [.17 + .12 * energy, .39 + .16 * energy, .10 + .03 * energy];
      const light = [1, .97, .47];
      const at = (y * TEXTURE + x) * 3;
      for (let channel = 0; channel < 3; channel++) {
        let value = yellow[channel] + (pollen[channel] - yellow[channel]) * band * .78;
        value += (green[channel] - value) * dark;
        value += (green[channel] - value) * veins * (.10 + energy * .22);
        out[at + channel] = (value + (light[channel] - value) * clamp(glow, 0, .65)) * 255;
      }
    }
  }
  return out;
}

export class IntroVortex {
  constructor(host, { reducedMotion = false } = {}) {
    this.reducedMotion = reducedMotion;
    this.canvas = makeCanvas();
    host.append(this.canvas);
    this.markCanvas = document.createElement('canvas');
    this.markCanvas.width = this.markCanvas.height = MARK_TEXTURE;
    this.markContext = this.markCanvas.getContext('2d', { willReadFrequently: true });
    this.lastFrame = {};
    this.resources = [];
    this.onContextLost = event => {
      event.preventDefault();
      this.useFallback();
      this.resize(this.width, this.height);
    };
    try {
      this.initializeGL();
    } catch (error) {
      console.info('Intro cloth is using its software renderer.', error);
      this.useFallback();
    }
    this.resize(host.clientWidth || innerWidth, host.clientHeight || innerHeight);
  }

  initializeGL() {
    const gl = this.canvas.getContext('webgl', { alpha: false, depth: true, antialias: false, powerPreference: 'low-power' });
    if (!gl) throw new Error('WebGL unavailable');
    this.gl = gl;
    const shader = (type, source) => {
      const handle = gl.createShader(type);
      this.resources.push(['deleteShader', handle]);
      gl.shaderSource(handle, source);
      gl.compileShader(handle);
      if (!gl.getShaderParameter(handle, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(handle));
      return handle;
    };
    const precision = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT)?.precision ? 'highp' : 'mediump';
    const shared = paintInterface(precision);
    const program = gl.createProgram();
    this.resources.push(['deleteProgram', program]);
    gl.attachShader(program, shader(gl.VERTEX_SHADER, shared + vertexSource));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, `precision ${precision} float;\n${shared}${fragmentBody}`));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    this.program = program;
    gl.useProgram(program);
    this.uniforms = Object.fromEntries(['resolution', 'shift', 'angle', 'time', 'velocity', 'progress', 'energy', 'markSpan', 'markOpacity', 'marks']
      .map(name => [name, gl.getUniformLocation(program, `u_${name}`)]));
    this.attributes = ['position','surface','material'].map((name, i) => {
      const buffer = gl.createBuffer();
      const location = gl.getAttribLocation(program, `a_${name}`);
      this.resources.push(['deleteBuffer', buffer]);
      return { name, buffer, location, size: [3, 4, 2][i] };
    });
    this.faces = gl.createBuffer();
    this.resources.push(['deleteBuffer', this.faces]);
    this.markTexture = gl.createTexture();
    this.resources.push(['deleteTexture', this.markTexture]);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.markTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, MARK_TEXTURE, MARK_TEXTURE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(1, .875, .015, 1);
    this.canvas.dataset.renderer = 'cloth-webgl';
    this.canvas.addEventListener('webglcontextlost', this.onContextLost);
  }

  releaseGL() {
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    if (this.gl) for (const [method, resource] of this.resources) this.gl[method](resource);
    this.resources.length = 0;
    this.gl = null;
  }

  useFallback() {
    this.releaseGL();
    const replacement = makeCanvas();
    this.canvas.replaceWith(replacement);
    this.canvas = replacement;
    this.canvas.dataset.renderer = 'cloth-canvas';
    this.context = replacement.getContext('2d', { alpha: false });
    this.mesh = null;
    this.markFocus = undefined;
  }

  resize(width, height) {
    width = Math.max(1, width);
    height = Math.max(1, height);
    if (this.mesh && this.width === width && this.height === height) return;
    this.width = width;
    this.height = height;
    const edge = Math.min(width, height);
    const ratio = this.gl
      ? Math.min(devicePixelRatio || 1, 1.5, Math.sqrt(1500000 / (width * height)))
      : Math.min(1, Math.sqrt(115000 / (width * height)));
    this.canvas.width = Math.max(1, Math.round(width * ratio));
    this.canvas.height = Math.max(1, Math.round(height * ratio));
    const span = Math.hypot(width, height) / edge * 1.25;
    const segments = this.gl ? clamp(Math.ceil(span / .053), 40, 68) : clamp(Math.ceil(span / .085), 28, 44);
    this.mesh = new ClothMesh(span, segments);
    this.contact = null;
    this.markRadius = Math.max(1, Math.min(112, width * .26, height * .245));
    this.markWidth = this.markRadius * 3.85 + 38;
    this.markSpan = this.markWidth / edge;
    this.markFocus = undefined;
    if (this.gl) {
      const gl = this.gl;
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.faces);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.mesh.indices, gl.STATIC_DRAW);
      for (const attr of this.attributes) {
        const data = this.mesh[attr.name === 'position' ? 'positions' : attr.name];
        gl.bindBuffer(gl.ARRAY_BUFFER, attr.buffer);
        gl.bufferData(gl.ARRAY_BUFFER, data, attr.name === 'material' ? gl.STATIC_DRAW : gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(attr.location);
        gl.vertexAttribPointer(attr.location, attr.size, gl.FLOAT, false, 0, 0);
      }
    } else if (this.context) {
      this.paint = [bakePaint(span, 0), bakePaint(span, 1)];
      this.pixels = this.context.createImageData(this.canvas.width, this.canvas.height);
      this.depth = new Float32Array(this.canvas.width * this.canvas.height);
      this.projected = new Float32Array(this.mesh.count * 4);
    }
    this.render(this.lastFrame);
  }

  setReducedMotion(value) {
    this.reducedMotion = Boolean(value);
    if (value) this.reset();
  }

  reset() {
    this.mesh?.reset();
    this.contact = null;
  }

  setFragments(fragments) {
    this.fragments = fragments;
    this.markFrame = undefined;
    this.render({ ...this.lastFrame, dt: 0 });
  }

  refreshMarks(time, progress, focused) {
    // The pieces can move across the viewport, so update their decal at 30 Hz.
    const step = Math.floor(time * 24);
    const gather = Math.round(progress * 50);
    const still = this.reducedMotion;
    const frame = this.fragments ? (still ? 0 : Math.floor(performance.now() * .030)) : step * 51 + gather;
    if (this.markFocus === focused && this.markFrame === frame && this.markStill === still) return;
    this.markFocus = focused;
    this.markFrame = frame;
    this.markStill = still;
    if (this.fragments) {
      const span = this.fragments.drawOrbit(this.markContext, {
        radius: this.markRadius, diagonal: Math.hypot(this.width, this.height), time, progress, focused, still,
      });
      this.markSpan = span / Math.min(this.width, this.height);
    } else {
      drawMarks(this.markContext, this.markRadius, this.markWidth, step / 24, gather / 50, focused, still);
    }
    if (this.gl) {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.markTexture);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.markCanvas);
    } else {
      this.markPixels = this.markContext.getImageData(0, 0, MARK_TEXTURE, MARK_TEXTURE).data;
    }
  }

  render(frame = {}) {
    this.lastFrame = frame;
    if (!this.mesh) return;
    let { time = 0, dt = 0, angle = 0, velocity = 0, progress = 0, energy = 0, shakeX = 0, shakeY = 0,
      grip = null, focused = false, marks = .65 } = frame;
    if (this.reducedMotion) {
      time = dt = angle = velocity = progress = energy = shakeX = shakeY = 0;
      grip = null;
    }
    this.refreshMarks(time, progress, focused);
    const edge = Math.min(this.width, this.height);
    if (grip) {
      const x = ((grip.x - .5) * this.width - shakeX) / edge;
      const y = ((grip.y - .5) * this.height - shakeY) / edge;
      const c = Math.cos(angle), s = Math.sin(angle);
      const u = x * c + y * s, v = y * c - x * s;
      if (this.contact !== grip) this.mesh.startGrab(u, v);
      this.mesh.moveGrab(u, v, grip.load, velocity, grip.follow);
    } else if (this.contact) {
      this.mesh.endGrab();
    }
    this.contact = grip;
    this.mesh.step(dt);
    const shiftX = shakeX * this.canvas.width / this.width;
    const shiftY = shakeY * this.canvas.height / this.height;
    if (this.gl) this.drawGL(time, angle, velocity, progress, energy, marks, shiftX, shiftY);
    else if (this.context) this.drawSoftware(time, angle, energy, marks, shiftX, shiftY);
  }

  drawGL(time, angle, velocity, progress, energy, marks, x, y) {
    const gl = this.gl, u = this.uniforms;
    gl.useProgram(this.program);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.uniform2f(u.resolution, this.canvas.width, this.canvas.height);
    gl.uniform2f(u.shift, x, y);
    gl.uniform1f(u.time, time % (TAU / .08));
    gl.uniform1f(u.angle, angle);
    gl.uniform1f(u.velocity, velocity);
    gl.uniform1f(u.progress, progress);
    gl.uniform1f(u.energy, energy);
    gl.uniform1f(u.markSpan, this.markSpan);
    gl.uniform1f(u.markOpacity, marks);
    gl.uniform1i(u.marks, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.attributes[0].buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.mesh.positions);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.attributes[1].buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.mesh.surface);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.faces);
    gl.drawElements(gl.TRIANGLES, this.mesh.indices.length, gl.UNSIGNED_SHORT, 0);
  }

  drawSoftware(time, angle, energy, marks, shiftX, shiftY) {
    // Same geometry, UVs and occlusion at a bounded resolution for Canvas-only
    // browsers. A depth buffer keeps the front of a folded triangle visible.
    const { width, height } = this.canvas;
    const edge = Math.min(width, height);
    const { positions, surface, material, span, count, indices } = this.mesh;
    const points = this.projected;
    const depth = this.depth;
    const pixels = this.pixels.data;
    const c = Math.cos(angle), s = Math.sin(angle);
    for (let i = 0; i < count; i++) {
      const p = i * 3, n = i * 4;
      const z = positions[p + 2];
      const scale = edge / (1 - CLOTH_PERSPECTIVE * z);
      points[n] = (positions[p] * c - positions[p + 1] * s) * scale + width / 2 + shiftX;
      points[n + 1] = (positions[p] * s + positions[p + 1] * c) * scale + height / 2 + shiftY;
      points[n + 2] = z;
      const direction = surface[n + 2] < 0 ? -1 : 1;
      const nx = (surface[n] * c - surface[n + 1] * s) * direction;
      const ny = (surface[n] * s + surface[n + 1] * c) * direction;
      const nz = Math.abs(surface[n + 2]);
      points[n + 3] = clamp(1 + .23 * (-.70 * nx - .48 * ny) - .09 * (1 - nz) - .14 * surface[n + 3], .78, 1.16);
    }
    depth.fill(-Infinity);
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = 255; pixels[i + 1] = 223; pixels[i + 2] = 4; pixels[i + 3] = 255;
    }
    const [low, high] = this.paint;
    const paintScale = (TEXTURE - 1) / span;
    const paintCenter = (TEXTURE - 1) / 2;
    const drift = time * .08;
    const zoom = 1 + .045 * Math.sin(drift);
    const paintX = .085 * Math.sin(drift * 2) * zoom;
    const paintY = .085 * (Math.cos(drift * 3) * zoom - 1);
    const markScale = MARK_TEXTURE / this.markSpan;
    const markCenter = MARK_TEXTURE / 2;
    for (let i = 0; i < indices.length; i += 3) {
      const ia = indices[i], ib = indices[i + 1], ic = indices[i + 2];
      const a = ia * 4, b = ib * 4, d = ic * 4;
      const ax = points[a], ay = points[a + 1], bx = points[b], by = points[b + 1], cx = points[d], cy = points[d + 1];
      const left = Math.max(0, Math.floor(Math.min(ax, bx, cx))), right = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)));
      const top = Math.max(0, Math.floor(Math.min(ay, by, cy))), bottom = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)));
      const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (left > right || top > bottom || Math.abs(det) < .001) continue;
      const inv = 1 / det;
      for (let y = top; y <= bottom; y++) {
        for (let x = left; x <= right; x++) {
          const ox = x + .5 - cx, oy = y + .5 - cy;
          const wa = ((by - cy) * ox + (cx - bx) * oy) * inv;
          const wb = ((cy - ay) * ox + (ax - cx) * oy) * inv;
          const wc = 1 - wa - wb;
          if (wa < -.0001 || wb < -.0001 || wc < -.0001) continue;
          const z = wa * points[a + 2] + wb * points[b + 2] + wc * points[d + 2];
          const pixel = y * width + x;
          if (z <= depth[pixel]) continue;
          depth[pixel] = z;
          const u = wa * material[ia * 2] + wb * material[ib * 2] + wc * material[ic * 2];
          const v = wa * material[ia * 2 + 1] + wb * material[ib * 2 + 1] + wc * material[ic * 2 + 1];
          const tx = clamp(Math.round((u * zoom + paintX) * paintScale + paintCenter), 0, TEXTURE - 1);
          const ty = clamp(Math.round((v * zoom + paintY) * paintScale + paintCenter), 0, TEXTURE - 1);
          const color = (ty * TEXTURE + tx) * 3;
          const mx = Math.floor(u * markScale + markCenter), my = Math.floor(v * markScale + markCenter);
          const mi = (my * MARK_TEXTURE + mx) * 4;
          const opacity = mx >= 0 && my >= 0 && mx < MARK_TEXTURE && my < MARK_TEXTURE ? this.markPixels[mi + 3] * marks / 255 : 0;
          const light = wa * points[a + 3] + wb * points[b + 3] + wc * points[d + 3];
          for (let j = 0; j < 3; j++) {
            let value = low[color + j] + (high[color + j] - low[color + j]) * energy;
            if (opacity) value += (this.markPixels[mi + j] - value) * opacity;
            pixels[pixel * 4 + j] = value * light;
          }
        }
      }
    }
    this.context.putImageData(this.pixels, 0, 0);
  }

  dispose() {
    this.releaseGL();
    this.mesh = null;
    this.canvas.remove();
  }
}
