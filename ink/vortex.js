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
uniform float u_time;
uniform float u_angle;
uniform float u_velocity;
uniform float u_progress;
uniform float u_energy;
uniform vec4 u_trail[6];

void main() {
  float edge = min(u_resolution.x, u_resolution.y);
  float pixel = max(1.0, edge / 570.0);
  vec2 cell = floor(gl_FragCoord.xy / pixel) * pixel;
  vec2 p = (cell - u_resolution * 0.5) / edge;
  p.y = -p.y;
  // Drag the pigment locally in the actual hand direction. The falloff shears
  // its edges into small eddies while the whole composition turns independently.
  vec2 wakeWarp = vec2(0.0);
  float wake = 0.0;
  for (int i = 0; i < 6; i++) {
    vec2 source = (u_trail[i].xy - 0.5) * u_resolution / edge;
    vec2 offset = p - source;
    vec2 drag = u_trail[i].zw;
    float influence = exp(-dot(offset, offset) * 32.0);
    float curl = offset.x * drag.y - offset.y * drag.x;
    wakeWarp += (drag + vec2(-offset.y, offset.x) * curl * 8.0) * influence;
    wake += length(drag) * 10.0 * influence;
  }
  wakeWarp /= max(1.0, length(wakeWarp) / 0.12);
  p -= wakeWarp;
  float drift = u_time * 0.08;
  float energy = clamp(u_energy + wake * 0.07, 0.0, 1.0);
  // Broad wandering motion remains visible even between gestures. It changes
  // the paint, while the accumulated drawing gently awakens its own rotation.
  p += 0.085 * vec2(sin(drift * 2.0), cos(drift * 3.0));
  p *= 1.0 + 0.045 * sin(drift);
  float radius = length(p);
  float polar = (radius < 0.00001 ? 0.0 : atan(p.y, p.x)) - u_angle;
  polar -= radius * (5.2 + energy * 0.8 + u_velocity * 0.018);
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
  float grain = fract(sin(dot(floor(cell * 0.5) * 0.01, vec2(17.1, 61.7))) * 971.3);
  colour *= 0.989 + grain * (0.019 + u_progress * 0.003);
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
    this.lastFrame = { time: 0, angle: 0, velocity: 0, progress: 0, energy: 0, brushTrail: [] };
    this.trailUniform = new Float32Array(24);
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
    this.uniforms = Object.fromEntries(['resolution', 'time', 'angle', 'velocity', 'progress', 'energy']
      .map(name => [name, gl.getUniformLocation(this.program, `u_${name}`)]));
    this.uniforms.trail = gl.getUniformLocation(this.program, 'u_trail[0]');
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

  render({ time = 0, angle = 0, velocity = 0, progress = 0, energy = 0, brushTrail = [] } = {}) {
    if (this.disposed) return;
    this.lastFrame = { time, angle, velocity, progress, energy, brushTrail };
    const phase = this.reducedMotion ? 0 : finite(angle) % TAU;
    // All time-dependent waves are integer multiples of the base .08t phase.
    const drift = this.reducedMotion ? 0 : finite(time) % (TAU / .08);
    const speed = this.reducedMotion ? 0 : clamp(finite(velocity), -12, 12);
    const filled = clamp(finite(progress), 0, 1);
    const motion = this.reducedMotion ? 0 : clamp(finite(energy), 0, 1);
    const trail = this.reducedMotion || !Array.isArray(brushTrail) ? [] : brushTrail.slice(-6);
    this.trailUniform.fill(0);
    trail.forEach((point, index) => {
      const contact = index === trail.length - 1 ? 1.45 : .12 + .28 * index / Math.max(1, trail.length - 1);
      const strength = clamp(finite(point.weight), 0, 1) * contact;
      this.trailUniform[index * 4] = clamp(finite(point.x, .5), 0, 1);
      this.trailUniform[index * 4 + 1] = clamp(finite(point.y, .5), 0, 1);
      this.trailUniform[index * 4 + 2] = clamp(finite(point.dx), -.065, .065) * strength;
      this.trailUniform[index * 4 + 3] = clamp(finite(point.dy), -.065, .065) * strength;
    });
    if (this.gl) {
      const gl = this.gl;
      gl.useProgram(this.program);
      gl.uniform2f(this.uniforms.resolution, this.canvas.width, this.canvas.height);
      gl.uniform1f(this.uniforms.time, drift);
      gl.uniform1f(this.uniforms.angle, phase);
      gl.uniform1f(this.uniforms.velocity, speed);
      gl.uniform1f(this.uniforms.progress, filled);
      gl.uniform1f(this.uniforms.energy, motion);
      gl.uniform4fv(this.uniforms.trail, this.trailUniform);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return;
    }
    const ctx = this.context;
    if (!ctx || !this.textures) return;
    const { width, height } = this.canvas;
    // Overscan includes the breathing and drift, so no edge can become exposed.
    const side = Math.hypot(width, height) * 1.22 + 2;
    const wave = drift * .08;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, width / 2, height / 2);
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
    // Locally displace the rendered paint in the Canvas fallback as well.
    // Feathered patches avoid a visible cursor, ring or rectangular cutout.
    const shortEdge = Math.min(width, height);
    if (trail.length) {
      this.wakeBase ||= document.createElement('canvas');
      this.wakePatch ||= document.createElement('canvas');
      if (this.wakeBase.width !== width) this.wakeBase.width = width;
      if (this.wakeBase.height !== height) this.wakeBase.height = height;
      this.wakeBase.getContext('2d').drawImage(this.canvas, 0, 0);
      if (this.wakePatch.width !== 192) this.wakePatch.width = this.wakePatch.height = 192;
    }
    ctx.save();
    trail.forEach((point, index) => {
      const contact = index === trail.length - 1 ? 1 : .12 + .28 * index / Math.max(1, trail.length - 1);
      const strength = clamp(finite(point.weight), 0, 1) * contact;
      const dx = clamp(finite(point.dx), -.065, .065) * shortEdge;
      const dy = clamp(finite(point.dy), -.065, .065) * shortEdge;
      if (!strength || Math.hypot(dx, dy) < .01) return;
      const x = point.x * width;
      const y = point.y * height;
      const side = shortEdge * .38;
      const patch = this.wakePatch.getContext('2d');
      patch.globalCompositeOperation = 'source-over';
      patch.clearRect(0, 0, 192, 192);
      patch.drawImage(this.wakeBase, x - side / 2 - dx * strength, y - side / 2 - dy * strength, side, side, 0, 0, 192, 192);
      const feather = patch.createRadialGradient(96, 96, 10, 96, 96, 96);
      feather.addColorStop(0, '#000');
      feather.addColorStop(.5, '#000b');
      feather.addColorStop(1, '#0000');
      patch.globalCompositeOperation = 'destination-in';
      patch.fillStyle = feather;
      patch.fillRect(0, 0, 192, 192);
      ctx.globalAlpha = strength * .9;
      ctx.drawImage(this.wakePatch, x - side / 2, y - side / 2, side, side);
    });
    ctx.restore();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseGL();
    this.textures = null;
    this.wakeBase = null;
    this.wakePatch = null;
    this.canvas.remove();
  }
}
