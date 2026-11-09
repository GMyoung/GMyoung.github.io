const TAU = Math.PI * 2;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

const vertexSource = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

// Original polar-warp implementation, inspired by the broad painted ribbons
// of Balatro. No original game shader or third-party shader source is bundled.
const fragmentBody = `
uniform vec2 u_resolution;
uniform vec2 u_shift;
uniform float u_time;
uniform float u_angle;
uniform float u_velocity;
uniform float u_progress;
uniform float u_energy;
uniform vec4 u_grip;
uniform vec2 u_pull;

void main() {
  float edge = min(u_resolution.x, u_resolution.y);
  float pixel = max(1.0, edge / 570.0);
  vec2 cell = floor(gl_FragCoord.xy / pixel) * pixel;
  vec2 p = (cell - u_resolution * 0.5) / edge;
  p.y = -p.y;
  float clothLight = 1.0;
  if (u_grip.z > 0.006) {
    // Gather the material at the contact. The ridges fan out along the pull,
    // and both the sampling warp and its light follow the same folds.
    vec2 contact = (u_grip.xy - 0.5) * u_resolution / edge;
    vec2 offset = p - contact;
    vec2 crossPull = vec2(-u_pull.y, u_pull.x);
    float along = dot(offset, u_pull);
    float across = dot(offset, crossPull);
    float back = max(-along, 0.0);
    float load = u_grip.w;
    vec3 shape = vec3(back / (0.18 + 0.25 * load), max(along, 0.0) / 0.17,
      across / (0.09 + 0.07 * load + back * 0.16));
    float cloth = u_grip.z * exp(-2.0 * dot(shape, shape));
    float tuck = u_grip.z * 0.34 * exp(-88.0 * dot(offset, offset));
    float ridge = across * (65.0 + 22.0 * load) / (1.0 + 2.25 * back) + 0.58 * sin(along * 17.0) + 0.55;
    float curl = sin(ridge) * (0.79 + 0.21 * sin(along * 19.0 + across * 13.0));
    vec2 pull = u_pull * (cloth * (0.022 + 0.075 * load) - along * tuck)
              + crossPull * (cloth * curl * (0.008 + 0.017 * load) - across * tuck);
    p -= pull;
    clothLight += cloth * (0.17 + 0.19 * load) * cos(ridge + 0.58) - tuck * 0.23;
  }
  p -= u_shift / edge;
  // Sample in the rotating paint space. All bands, grain and their wandering
  // centers turn together while the folds stay attached to the hand.
  float c = cos(u_angle);
  float s = sin(u_angle);
  p = mat2(c, -s, s, c) * p;
  vec2 material = p;
  float drift = u_time * 0.08;
  float energy = u_energy;
  // Broad wandering motion remains visible even between gestures. It changes
  // the paint, while the accumulated drawing gently awakens its own rotation.
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
  // More moving paint exposes nested, finer filaments, not just a faster copy
  // of the same texture. Smooth input energy keeps these changes continuous.
  float filament = sin(field * (7.0 + energy * 6.0) + q.x * 1.5 - q.y * 1.8 + drift * 4.0);
  float veins = smoothstep(0.48, 0.90, filament) * band;
  float edgeLight = 1.0 - smoothstep(0.02, 0.18, abs(field - 0.28));
  vec3 yellow = mix(vec3(1.0, 0.875, 0.015), vec3(1.0, 0.93, 0.18), energy);
  vec3 pollen = mix(vec3(0.69, 0.73, 0.08), vec3(0.78, 0.84, 0.15), energy);
  vec3 green = mix(vec3(0.17, 0.39, 0.10), vec3(0.29, 0.55, 0.13), energy);
  vec3 colour = mix(yellow, pollen, band * 0.78);
  colour = mix(colour, green, dark * 0.82);
  colour = mix(colour, green, veins * (0.10 + energy * 0.22));
  float glow = edgeLight * (0.10 + energy * 0.42)
             + veins * (0.025 + energy * 0.16);
  colour = mix(colour, vec3(1.0, 0.97, 0.47), clamp(glow, 0.0, 0.65));
  float grain = fract(sin(dot(floor(material * edge * 0.5) * 0.01, vec2(17.1, 61.7))) * 971.3);
  colour *= 0.989 + grain * (0.019 + u_progress * 0.003);
  colour *= clothLight;
  gl_FragColor = vec4(colour, 1.0);
}`;

function makeCanvas() {
  const canvas = document.createElement('canvas');
  canvas.className = 'intro-vortex-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'display:block;width:100%;height:100%;pointer-events:none';
  return canvas;
}

function smoothstep(a, b, value) {
  const t = clamp((value - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

// The same local fold field moves fragments and remaps the Canvas backdrop.
// Coordinates and displacements are in units of the viewport's short edge.
export function foldAt(along, across, { pressure, load }, result) {
  const back = Math.max(-along, 0);
  const cloth = pressure * Math.exp(-2 * ((back / (.18 + .25 * load)) ** 2 +
    (Math.max(along, 0) / .17) ** 2 + (across / (.09 + .07 * load + back * .16)) ** 2));
  const tuck = pressure * .34 * Math.exp(-88 * (along * along + across * across));
  const ridge = across * (65 + 22 * load) / (1 + 2.25 * back) + .58 * Math.sin(along * 17) + .55;
  const curl = Math.sin(ridge) * (.79 + .21 * Math.sin(along * 19 + across * 13));
  result.along = cloth * (.022 + .075 * load) - along * tuck;
  result.across = cloth * curl * (.008 + .017 * load) - across * tuck;
  result.light = 1 + cloth * (.17 + .19 * load) * Math.cos(ridge + .58) - tuck * .23;
}

export class IntroVortex {
  constructor(host, { reducedMotion = false } = {}) {
    this.host = host;
    this.reducedMotion = reducedMotion;
    this.canvas = makeCanvas();
    this.host.append(this.canvas);
    this.gl = null;
    this.program = null;
    this.buffer = null;
    this.shaders = [];
    this.disposed = false;
    this.lastFrame = {};
    this.onContextLost = event => {
      event.preventDefault();
      if (this.disposed) return;
      this.useFallback();
      this.resize(this.width, this.height);
      this.render(this.lastFrame);
    };
    try {
      this.initializeGL();
    } catch {
      this.useFallback();
    }
    this.resize(host.clientWidth || innerWidth, host.clientHeight || innerHeight);
    this.render(this.lastFrame);
  }

  initializeGL() {
    const gl = this.canvas.getContext('webgl', {
      alpha: false, antialias: false, depth: false, stencil: false,
      powerPreference: 'low-power', preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL unavailable');
    this.gl = gl;
    const precision = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    const qualifier = precision && precision.precision > 0 ? 'highp' : 'mediump';
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('Shader allocation failed');
      this.shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('Shader compilation failed');
      return shader;
    };
    const vertex = compile(gl.VERTEX_SHADER, vertexSource);
    const fragment = compile(gl.FRAGMENT_SHADER, `precision ${qualifier} float;\n${fragmentBody}`);
    this.program = gl.createProgram();
    if (!this.program) throw new Error('Program allocation failed');
    gl.attachShader(this.program, vertex);
    gl.attachShader(this.program, fragment);
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error('Shader linking failed');
    gl.useProgram(this.program);
    this.buffer = gl.createBuffer();
    if (!this.buffer) throw new Error('Buffer allocation failed');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(this.program, 'a_position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    this.uniforms = Object.fromEntries(['resolution', 'shift', 'time', 'angle', 'velocity', 'progress', 'energy', 'grip', 'pull']
      .map(name => [name, gl.getUniformLocation(this.program, `u_${name}`)]));
    this.canvas.addEventListener('webglcontextlost', this.onContextLost);
    this.canvas.dataset.renderer = 'webgl';
  }

  releaseGL() {
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    if (this.gl) {
      if (this.buffer) this.gl.deleteBuffer(this.buffer);
      if (this.program) this.gl.deleteProgram(this.program);
      for (const shader of this.shaders) this.gl.deleteShader(shader);
    }
    this.buffer = null;
    this.program = null;
    this.shaders = [];
    this.gl = null;
  }

  useFallback() {
    this.releaseGL();
    const replacement = makeCanvas();
    this.canvas.replaceWith(replacement);
    this.canvas = replacement;
    this.canvas.dataset.renderer = 'canvas';
    this.context = this.canvas.getContext('2d', { alpha: false });
    this.textures = [this.makeFallbackTexture(0), this.makeFallbackTexture(1)];
  }

  makeFallbackTexture(energy) {
    // Low/high energy paint is computed once and crossfaded during interaction.
    // Every frame only transforms and blends these small textures.
    const texture = document.createElement('canvas');
    texture.width = texture.height = 256;
    const context = texture.getContext('2d');
    const image = context.createImageData(256, 256);
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        const px = (x - 128) / 128;
        const py = (y - 128) / 128 + .085;
        const radius = Math.hypot(px, py);
        const angle = Math.atan2(py, px) - radius * (5.2 + energy * .8) - .25 * Math.sin(radius * 5);
        let qx = radius * Math.cos(angle) * 2.8;
        let qy = radius * Math.sin(angle) * 2.8;
        for (let layer = 0; layer < 3; layer++) {
          const amplitude = .34 - layer * .05;
          const nextX = qx + amplitude * Math.sin(qy * 1.6 + layer * 1.8);
          qy += amplitude * Math.cos(qx * 1.9 - layer * .9);
          qx = nextX;
        }
        const field = Math.sin(qx * 3.2 + Math.sin(qy * 1.6)) + .65 * Math.cos(qy * 2.7 - qx * .6);
        const band = smoothstep(-.1, .65, field);
        const dark = smoothstep(.8, 1.35, field);
        const filament = Math.sin(field * (7 + energy * 6) + qx * 1.5 - qy * 1.8);
        const veins = smoothstep(.48, .9, filament) * band;
        const edgeLight = 1 - smoothstep(.02, .18, Math.abs(field - .28));
        const glow = clamp(edgeLight * (.10 + energy * .42) + veins * (.025 + energy * .16), 0, .65);
        const yellow = [1, .875 + .055 * energy, .015 + .165 * energy];
        const pollen = [.69 + .09 * energy, .73 + .11 * energy, .08 + .07 * energy];
        const green = [.17 + .12 * energy, .39 + .16 * energy, .10 + .03 * energy];
        const light = [1, .97, .47];
        const at = (y * 256 + x) * 4;
        for (let channel = 0; channel < 3; channel++) {
          let colour = yellow[channel] + (pollen[channel] - yellow[channel]) * band * .78;
          colour += (green[channel] - colour) * dark * .82;
          colour += (green[channel] - colour) * veins * (.10 + energy * .22);
          colour += (light[channel] - colour) * glow;
          image.data[at + channel] = Math.round(colour * 255);
        }
        image.data[at + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
    return texture;
  }

  resize(width, height) {
    if (this.disposed) return;
    this.width = Math.max(1, finite(width, 1));
    this.height = Math.max(1, finite(height, 1));
    const pixelRatio = Math.min(finite(devicePixelRatio, 1), 1.5, Math.sqrt(1500000 / (this.width * this.height)));
    const bufferWidth = Math.max(1, Math.round(this.width * pixelRatio));
    const bufferHeight = Math.max(1, Math.round(this.height * pixelRatio));
    if (this.canvas.width !== bufferWidth) this.canvas.width = bufferWidth;
    if (this.canvas.height !== bufferHeight) this.canvas.height = bufferHeight;
    if (this.gl) this.gl.viewport(0, 0, bufferWidth, bufferHeight);
    this.render(this.lastFrame);
  }

  setReducedMotion(value) {
    this.reducedMotion = Boolean(value);
    this.render(this.lastFrame);
  }

  render({ time = 0, angle = 0, velocity = 0, progress = 0, energy = 0, shakeX = 0, shakeY = 0, grip = null } = {}) {
    if (this.disposed) return;
    this.lastFrame = { time, angle, velocity, progress, energy, shakeX, shakeY, grip };
    const { width, height } = this.canvas;
    const shiftX = this.reducedMotion ? 0 : finite(shakeX) * width / this.width;
    const shiftY = this.reducedMotion ? 0 : finite(shakeY) * height / this.height;
    const phase = this.reducedMotion ? 0 : finite(angle) % TAU;
    // All time-dependent waves are integer multiples of the base .08t phase.
    const drift = this.reducedMotion ? 0 : finite(time) % (TAU / .08);
    const speed = this.reducedMotion ? 0 : clamp(finite(velocity), -12, 12);
    const filled = clamp(finite(progress), 0, 1);
    const motion = this.reducedMotion ? 0 : clamp(finite(energy), 0, 1);
    const contact = !this.reducedMotion && grip?.pressure > .006 ? grip : null;
    if (this.gl) {
      const gl = this.gl;
      gl.useProgram(this.program);
      gl.uniform2f(this.uniforms.resolution, width, height);
      gl.uniform2f(this.uniforms.shift, shiftX, shiftY);
      gl.uniform1f(this.uniforms.time, drift);
      gl.uniform1f(this.uniforms.angle, phase);
      gl.uniform1f(this.uniforms.velocity, speed);
      gl.uniform1f(this.uniforms.progress, filled);
      gl.uniform1f(this.uniforms.energy, motion);
      gl.uniform4f(this.uniforms.grip, contact?.x ?? .5, contact?.y ?? .5, contact?.pressure ?? 0, contact?.load ?? 0);
      const direction = contact?.direction ?? 0;
      gl.uniform2f(this.uniforms.pull, Math.cos(direction), Math.sin(direction));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return;
    }
    const ctx = this.context;
    if (!ctx || !this.textures) return;
    // Overscan includes the breathing and drift, so no edge can become exposed.
    const side = Math.hypot(width, height) * 1.22 + 2;
    const wave = drift * .08;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, width / 2 + shiftX, height / 2 + shiftY);
    ctx.rotate(phase);
    ctx.translate(side * .045 * Math.sin(wave * 2), side * .045 * Math.cos(wave * 3));
    const breath = 1 + .035 * Math.sin(wave);
    ctx.scale(breath, 1 / breath);
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = 1;
    ctx.drawImage(this.textures[0], -side / 2, -side / 2, side, side);
    if (motion > 0) {
      ctx.globalAlpha = motion;
      ctx.drawImage(this.textures[1], -side / 2, -side / 2, side, side);
    }
    ctx.restore();
    if (contact) this.paintCloth(ctx, contact);
  }

  paintCloth(ctx, grip) {
    // On devices without WebGL, remap a small patch of the real paint. Its
    // edges feather out so the folded patch remains part of the same sheet.
    const size = 96;
    if (!this.clothBuffers) {
      const source = document.createElement('canvas');
      const target = document.createElement('canvas');
      source.width = source.height = target.width = target.height = size;
      const sample = source.getContext('2d', { willReadFrequently: true });
      const paint = target.getContext('2d');
      this.clothBuffers = { sample, paint, pixels: paint.createImageData(size, size) };
    }
    const { sample, paint, pixels } = this.clothBuffers;
    const { width, height } = this.canvas;
    const shortEdge = Math.min(width, height);
    const span = shortEdge * .90;
    const x = grip.x * width;
    const y = grip.y * height;
    const anchor = size * .65;
    const middle = size * .5;
    sample.clearRect(0, 0, size, size);
    sample.save();
    sample.translate(anchor, middle);
    sample.scale(size / span, size / span);
    sample.rotate(-grip.direction);
    sample.translate(-x, -y);
    sample.drawImage(this.canvas, 0, 0);
    sample.restore();

    const original = sample.getImageData(0, 0, size, size).data;
    const result = pixels.data;
    const step = .90 / size;
    const fold = { along: 0, across: 0, light: 1 };
    for (let row = 0; row < size; row++) {
      const across = (row + .5 - middle) * step;
      for (let column = 0; column < size; column++) {
        const along = (column + .5 - anchor) * step;
        foldAt(along, across, grip, fold);
        const fromX = clamp(Math.round(column - fold.along / step), 0, size - 1);
        const fromY = clamp(Math.round(row - fold.across / step), 0, size - 1);
        const from = (fromY * size + fromX) * 4;
        const at = (row * size + column) * 4;
        const edge = Math.max(Math.abs((column + .5) / size - .5), Math.abs((row + .5) / size - .5));
        for (let channel = 0; channel < 3; channel++) result[at + channel] = original[from + channel] * fold.light;
        result[at + 3] = original[from + 3] * (1 - smoothstep(.36, .5, edge));
      }
    }
    paint.putImageData(pixels, 0, 0);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(grip.direction);
    ctx.globalAlpha = Math.min(1, grip.pressure * 1.5);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(paint.canvas, -anchor / size * span, -span / 2, span, span);
    ctx.restore();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseGL();
    this.textures = null;
    this.clothBuffers = null;
    this.canvas.remove();
  }
}
