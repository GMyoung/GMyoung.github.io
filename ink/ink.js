import { createFluid } from './vendor/fluid-solver.js';
import { paintBrushStamps as paintSharedBrushStamps } from './brush.js';

const palettes = {
  sumi: [0.12, 0.15, 0.13],
  jade: [0.13, 0.25, 0.17],
  indigo: [0.12, 0.17, 0.28],
  amber: [0.27, 0.17, 0.09],
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const WRITING_FADE_RATE = .8;
const WRITING_LIFETIME = Math.log(255) / WRITING_FADE_RATE;
const waterModes = {
  heavy: { fade: 1, current: 1.2, drift: 1, emission: 1 },
  light: { fade: .15, current: .55, drift: .7, emission: .92 },
  still: { fade: 0, current: .22, drift: .45, emission: .8 },
};

// Three separate ink masses frame the writing space. Coordinates use the same
// top-left origin in GPU and Canvas composition; only GPU injection flips y.
const ambientClouds = [
  { x: .15, y: .23, radius: .22, spreadX: .075, spreadY: .065, density: .42, phase: .6 },
  { x: .84, y: .32, radius: .20, spreadX: .065, spreadY: .08, density: .38, phase: 2.8 },
  { x: .57, y: .85, radius: .24, spreadX: .12, spreadY: .045, density: .36, phase: 4.4 },
];

function cloudPosition(cloud, time) {
  return {
    x: cloud.x + Math.sin(time * .075 + cloud.phase) * .022,
    y: cloud.y + Math.cos(time * .062 + cloud.phase) * .025,
  };
}

function emitterPosition(time) {
  const angle = time * .34 - 2.35;
  return {
    x: .5 + Math.cos(angle) * .34 + Math.sin(angle * 2.1) * .025,
    y: .52 + Math.sin(angle) * .32 + Math.cos(angle * 1.7) * .025,
  };
}

export class InkScene {
  constructor(container, options = {}) {
    this.container = container;
    this.options = options;
    this.active = false;
    this.paused = Boolean(options.reducedMotion);
    this.reducedMotion = Boolean(options.reducedMotion);
    this.time = 0;
    this.waterMode = 'heavy';
    this.writingFlow = true;
    this.writingClock = 0;
    this.ambientAge = 0;
    this.emissionResumeAt = 0;
    this.ambientTrail = [];
    this.trailDose = 0;
    this.nextTrailSample = 0;
    this.frame = 0;
    this.fallbackFrame = 0;
    this.palette = 'sumi';
    this.fallbackMarks = [];
    this.brushHistory = [];
    this.brushHistoryCount = 0;
    this.brushMask = document.createElement('canvas');
    this.brushMaskContext = this.brushMask.getContext('2d');
    this.maskDirty = false;
    this.writingCheckpoint = null;
    this.checkpointAt = 0;
    this.writingSurface = document.createElement('canvas');
    this.pendingMotion = null;
    this.ambientAmount = 1;
    this.tick = this.tick.bind(this);
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('aria-hidden', 'true');
    this.canvas.style.cssText = 'width:100%;height:100%;display:block';
    container.append(this.canvas);
    try {
      this.engine = createFluid(this.canvas);
      this.engine.setWritingFlow(true);
      this.seedInk();
      this.engine.render();
      this.canvas.addEventListener('webglcontextlost', event => {
        event.preventDefault();
        this.useFallback();
      }, { once: true });
    } catch (error) {
      console.info('Fluid ink is using its lightweight fallback.', error);
      this.useFallback();
    }
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
  }

  seedInk() {
    ambientClouds.forEach(cloud => this.emitCloud(cloud));
  }

  emitCloud(cloud) {
    if (!this.engine) return;
    const center = cloudPosition(cloud, this.time);
    for (let lobe = 0; lobe < 6; lobe++) {
      const angle = cloud.phase + this.time * .18 + lobe * Math.PI * 2 / 5;
      const core = lobe === 0;
      const x = center.x + (core ? 0 : Math.cos(angle) * cloud.spreadX);
      const y = center.y + (core ? 0 : Math.sin(angle) * cloud.spreadY);
      const amount = cloud.density * (core ? 1 : .58);
      const speed = 16;
      this.engine.splat(x, 1 - y, -Math.sin(angle) * speed,
        -Math.cos(angle) * speed, amount, cloud.radius * (core ? 1 : .72));
    }
  }

  emitMovingInk(dt) {
    if (this.ambientAge < this.emissionResumeAt) return;
    const mode = waterModes[this.waterMode];
    const point = emitterPosition(this.time);
    const next = emitterPosition(this.time + .1);
    const angle = Math.atan2(next.y - point.y, next.x - point.x);
    const amount = .72 * mode.emission * this.ambientAmount * dt;
    // One source moves continuously; dose and force are per second rather than
    // per frame. Existing dye dissipation limits its steady-state density.
    const force = 125 * mode.current * dt;
    this.engine?.splat(point.x, 1 - point.y, Math.cos(angle) * force,
      -Math.sin(angle) * force, amount, .19);
    this.trailDose += amount;
    if (this.ambientAge >= this.nextTrailSample) {
      this.ambientTrail.push({ ...point, at: this.ambientAge, amount: this.trailDose });
      this.trailDose = 0;
      this.nextTrailSample = this.ambientAge + .15;
    }
    this.ambientTrail = this.ambientTrail.filter(mark => this.ambientAge - mark.at < 12).slice(-80);
  }

  useFallback() {
    cancelAnimationFrame(this.frame);
    this.engine?.dispose();
    this.engine = null;
    this.resetBrushMask();
    const replacement = document.createElement('canvas');
    replacement.setAttribute('aria-hidden', 'true');
    replacement.style.cssText = 'width:100%;height:100%;display:block';
    this.canvas.replaceWith(replacement);
    this.canvas = replacement;
    this.options.onFallback?.();
    this.renderFallback();
    this.syncLoop();
  }

  renderFallback() {
    cancelAnimationFrame(this.fallbackFrame);
    this.fallbackFrame = 0;
    this.lastFallbackFrame = performance.now();
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    const context = this.canvas.getContext('2d');
    context.clearRect(0, 0, width, height);
    const color = palettes[this.palette].map(value => Math.round(value * 255)).join(',');
    for (const cloud of ambientClouds) {
      const center = cloudPosition(cloud, this.time);
      for (let lobe = 0; lobe < 6; lobe++) {
        const angle = cloud.phase + this.time * .10 + lobe * Math.PI * 2 / 5;
        const core = lobe === 0;
        const x = width * (center.x + (core ? 0 : Math.cos(angle) * cloud.spreadX));
        const y = height * (center.y + (core ? 0 : Math.sin(angle) * cloud.spreadY));
        const radius = Math.min(width, height) * cloud.radius * (core ? 2.15 : 1.45);
        const alpha = cloud.density * this.ambientAmount * (core ? .85 : .32);
        const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
        gradient.addColorStop(0, `rgba(${color},${alpha})`);
        gradient.addColorStop(.45, `rgba(${color},${alpha * .42})`);
        gradient.addColorStop(1, `rgba(${color},0)`);
        context.fillStyle = gradient;
        context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
      }
    }
    for (const mark of this.ambientTrail) {
      const x = mark.x * width;
      const y = mark.y * height;
      const radius = Math.min(width, height) * .38;
      const density = mark.amount * Math.exp(-(this.ambientAge - mark.at) * .24);
      const alpha = (1 - Math.exp(-density * 1.17)) * .95;
      const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
      gradient.addColorStop(0, `rgba(${color},${alpha})`);
      gradient.addColorStop(.5, `rgba(${color},${alpha * .37})`);
      gradient.addColorStop(1, `rgba(${color},0)`);
      context.fillStyle = gradient;
      context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }
    this.pruneBrushHistory();
    if (this.brushHistory.length || this.fallbackMarks.length || this.writingCheckpoint) {
      const surface = this.composeWritingMask();
      const inkContext = surface.getContext('2d', { willReadFrequently: true });
      const image = inkContext.getImageData(0, 0, surface.width, surface.height);
      const rgb = palettes[this.palette].map(value => Math.round(value * 255));
      // Convert the max-opacity grayscale field to a colored alpha image only
      // on the Canvas fallback. This avoids repeatedly darkening old overlaps.
      for (let index = 0; index < image.data.length; index += 4) {
        image.data[index + 3] = Math.round(image.data[index] * .95);
        image.data[index] = rgb[0];
        image.data[index + 1] = rgb[1];
        image.data[index + 2] = rgb[2];
      }
      inkContext.putImageData(image, 0, 0);
      context.drawImage(surface, 0, 0, width, height);
    }
  }

  requestFallbackRender() {
    if (this.fallbackFrame) return;
    this.fallbackFrame = requestAnimationFrame(() => this.renderFallback());
  }

  resize() {
    if (this.engine) {
      try {
        this.flushBrushMask();
        this.engine?.resize();
        this.engine?.render();
      } catch (error) {
        console.info('Fluid ink resized into its lightweight fallback.', error);
        this.useFallback();
      }
    } else {
      this.renderFallback();
    }
  }

  syncLoop() {
    cancelAnimationFrame(this.frame);
    if (!this.active || ((this.paused || this.reducedMotion) && !this.writingFlow)) return;
    this.lastFrame = performance.now();
    this.frame = requestAnimationFrame(this.tick);
  }

  setActive(active) {
    if (!active) this.flushBrushMask();
    this.active = active;
    this.syncLoop();
    if (active) this.engine?.render();
  }

  setPaused(paused) {
    if (paused) this.flushBrushMask();
    this.paused = paused;
    this.syncLoop();
  }

  setReducedMotion(reducedMotion) {
    if (reducedMotion) this.flushBrushMask();
    this.reducedMotion = reducedMotion;
    this.syncLoop();
  }

  setWritingFlow(enabled) {
    this.setWaterMode(enabled ? 'heavy' : 'still');
  }

  setWaterMode(mode) {
    if (!Object.hasOwn(waterModes, mode)) return;
    this.flushBrushMask();
    this.waterMode = mode;
    this.writingFlow = waterModes[mode].fade > 0;
    this.engine?.setWritingFlow(this.writingFlow);
    this.syncLoop();
    this.engine?.render();
    if (!this.engine) this.renderFallback();
  }

  getWritingClock() {
    // Integrated heavy-flow-equivalent seconds keep restored stamps at the
    // correct opacity after any number of heavy/light/still changes.
    return this.writingClock;
  }

  setPalette(name) {
    if (!palettes[name]) return;
    this.palette = name;
    if (this.engine) {
      this.engine.setColor(palettes[name]);
      this.engine.render();
    } else {
      this.renderFallback();
    }
  }

  capture() {
    // Render and copy synchronously because the WebGL drawing buffer is transient.
    this.flushBrushMask();
    this.engine?.render();
    if (!this.engine) this.renderFallback();
    const snapshot = document.createElement('canvas');
    snapshot.width = this.canvas.width;
    snapshot.height = this.canvas.height;
    snapshot.getContext('2d').drawImage(this.canvas, 0, 0);
    return snapshot;
  }

  resetBrushMask() {
    this.brushMaskContext.save();
    this.brushMaskContext.setTransform(1, 0, 0, 1, 0, 0);
    this.brushMaskContext.globalCompositeOperation = 'source-over';
    this.brushMaskContext.fillStyle = '#000';
    this.brushMaskContext.fillRect(0, 0, this.brushMask.width, this.brushMask.height);
    this.brushMaskContext.restore();
    this.maskDirty = false;
    this.pendingMotion = null;
  }

  prepareBrushMask() {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    // Match CSS geometry while bounding full-frame uploads on high-DPI screens.
    const ratio = Math.min(devicePixelRatio || 1, 2, 2048 / Math.max(width, height));
    const pixelsWide = Math.round(width * ratio);
    const pixelsHigh = Math.round(height * ratio);
    if (this.brushMask.width !== pixelsWide || this.brushMask.height !== pixelsHigh) {
      this.flushBrushMask();
      this.brushMask.width = pixelsWide;
      this.brushMask.height = pixelsHigh;
    }
    if (!this.maskDirty) this.resetBrushMask();
    this.brushMaskContext.setTransform(pixelsWide / width, 0, 0, pixelsHigh / height, 0, 0);
    return { width, height };
  }

  pruneBrushHistory() {
    this.brushHistory = this.brushHistory.filter(batch => this.writingClock - batch.latestInkTime < WRITING_LIFETIME);
    this.brushHistoryCount = this.brushHistory.reduce((count, batch) => count + batch.stamps.length, 0);
    this.fallbackMarks = this.fallbackMarks.filter(mark => this.writingClock - mark.inkTime < WRITING_LIFETIME);
    if (this.writingCheckpoint && this.writingClock - this.checkpointAt >= WRITING_LIFETIME) {
      this.writingCheckpoint = null;
    }
    // Visible old ink is flattened, never deleted to satisfy the memory cap.
    if (this.brushHistoryCount > 40000 || this.fallbackMarks.length > 7000) {
      const surface = this.composeWritingMask();
      const checkpoint = document.createElement('canvas');
      checkpoint.width = surface.width;
      checkpoint.height = surface.height;
      checkpoint.getContext('2d').drawImage(surface, 0, 0);
      this.writingCheckpoint = checkpoint;
      this.checkpointAt = this.writingClock;
      this.brushHistory.length = 0;
      this.brushHistoryCount = 0;
      this.fallbackMarks.length = 0;
    }
  }

  paintTimedStamps(context, stamps, createdAt) {
    context.save();
    context.globalCompositeOperation = 'lighten';
    let start = 0;
    while (start < stamps.length) {
      const stampTime = stamp => Number.isFinite(stamp.inkTime) ? stamp.inkTime : createdAt;
      const inkTime = stampTime(stamps[start]);
      let end = start + 1;
      while (end < stamps.length && stampTime(stamps[end]) === inkTime) end++;
      const opacity = Math.exp(-WRITING_FADE_RATE * Math.max(0, this.writingClock - inkTime));
      if (opacity >= 1 / 255) {
        const gray = Math.round(opacity * 255);
        paintSharedBrushStamps(context, stamps.slice(start, end), `rgb(${gray},${gray},${gray})`);
      }
      start = end;
    }
    context.restore();
  }

  composeWritingMask() {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    const ratio = Math.min(devicePixelRatio || 1, 2, 1536 / Math.max(width, height));
    const surface = this.writingSurface;
    const pixelsWide = Math.max(1, Math.round(width * ratio));
    const pixelsHigh = Math.max(1, Math.round(height * ratio));
    if (surface.width !== pixelsWide) surface.width = pixelsWide;
    if (surface.height !== pixelsHigh) surface.height = pixelsHigh;
    const context = surface.getContext('2d', { willReadFrequently: true });
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'source-over';
    context.fillStyle = '#000';
    context.fillRect(0, 0, pixelsWide, pixelsHigh);
    if (this.writingCheckpoint) {
      context.globalAlpha = Math.exp(-WRITING_FADE_RATE * Math.max(0, this.writingClock - this.checkpointAt));
      context.drawImage(this.writingCheckpoint, 0, 0, pixelsWide, pixelsHigh);
      context.globalAlpha = 1;
    }
    context.setTransform(pixelsWide / width, 0, 0, pixelsHigh / height, 0, 0);
    for (const batch of this.brushHistory) {
      context.save();
      context.scale(width / batch.width, height / batch.height);
      this.paintTimedStamps(context, batch.stamps, batch.inkTime);
      context.restore();
    }
    context.globalCompositeOperation = 'lighten';
    context.lineCap = 'round';
    context.lineJoin = 'round';
    for (const mark of this.fallbackMarks) {
      const opacity = Math.exp(-WRITING_FADE_RATE * Math.max(0, this.writingClock - mark.inkTime));
      const gray = Math.round(255 * opacity * (.68 + mark.pressure * .25));
      context.strokeStyle = `rgb(${gray},${gray},${gray})`;
      context.lineWidth = mark.radius * height * 2;
      context.beginPath();
      context.moveTo(mark.px * width, mark.py * height);
      context.lineTo(mark.x * width + .01, mark.y * height);
      context.stroke();
    }
    context.globalCompositeOperation = 'source-over';
    return surface;
  }

  // Demo and real writing share this exact geometry painter. The GPU receives
  // its opacity mask, never a separately reconstructed stroke silhouette.
  // Legacy holdSeconds is intentionally superseded by the global flow switch.
  paintBrushStamps(stamps, { motion } = {}) {
    if (!this.active || !Array.isArray(stamps) || !stamps.length) return;
    const { width, height } = this.prepareBrushMask();
    const inkTime = this.writingClock;
    const latestInkTime = stamps.reduce((latest, stamp) => Math.max(latest,
      Number.isFinite(stamp.inkTime) ? stamp.inkTime : inkTime), -Infinity);
    const batch = { stamps: stamps.slice(), width, height, inkTime, latestInkTime };
    this.brushHistory.push(batch);
    this.brushHistoryCount += stamps.length;
    if (this.brushHistoryCount > 40000) this.pruneBrushHistory();
    if (this.engine) {
      this.paintTimedStamps(this.brushMaskContext, stamps, inkTime);
      this.maskDirty = true;
      if (motion && [motion.x, motion.y, motion.dx, motion.dy].every(Number.isFinite)) {
        const previous = this.pendingMotion;
        this.pendingMotion = {
          x: clamp(motion.x / width, 0, 1), y: clamp(1 - motion.y / height, 0, 1),
          dx: clamp((previous?.dx || 0) + motion.dx * 2, -100, 100),
          dy: clamp((previous?.dy || 0) - motion.dy * 2, -100, 100),
        };
      }
      if (this.paused || this.reducedMotion) {
        this.flushBrushMask();
        this.engine?.render();
      }
    } else {
      this.requestFallbackRender();
    }
  }

  flushBrushMask() {
    if (!this.maskDirty) return;
    if (this.engine) {
      try {
        this.engine.depositMask(this.brushMask);
        const motion = this.pendingMotion;
        if (motion && (motion.dx || motion.dy)) {
          const current = waterModes[this.waterMode].current;
          this.engine.moveInk(motion.x, motion.y, motion.dx * current, motion.dy * current);
        }
      } catch (error) {
        console.info('Brush ink continued using its shared-painter fallback.', error);
        this.useFallback();
      }
    }
    this.resetBrushMask();
  }

  drop() {
    if (!this.engine) return;
    const x = 0.24 + Math.random() * 0.52;
    const y = 0.25 + Math.random() * 0.5;
    for (let index = 0; index < 4; index++) {
      const angle = index * Math.PI / 2 + this.time;
      this.engine.splat(x + Math.cos(angle) * 0.035, y + Math.sin(angle) * 0.035,
        Math.cos(angle + 0.7) * 135, Math.sin(angle + 0.7) * 135, 0.75);
    }
    this.engine.render();
  }

  splatAt(clientX, clientY, dx = 0, dy = 0) {
    if (!this.engine || !this.active) return;
    const bounds = this.container.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return;
    const x = (clientX - bounds.left) / bounds.width;
    const y = 1 - (clientY - bounds.top) / bounds.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    this.engine.splat(x, y, Math.max(-150, Math.min(150, dx * 7)),
      Math.max(-150, Math.min(150, -dy * 7)), 0.10);
    if (this.paused || this.reducedMotion) this.engine.render();
  }

  // size is the nominal brush radius in CSS px; speed is CSS px / millisecond.
  // dx/dy join the previous sample, so callers need not interpolate the stroke.
  brushAt(clientX, clientY, dx = 0, dy = 0, { size = 12, pressure = 0.5, speed = 0, holdSeconds = 18 } = {}) {
    if (!this.active) return;
    const bounds = this.container.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const x = (clientX - bounds.left) / bounds.width;
    const y = (clientY - bounds.top) / bounds.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    pressure = clamp(Number.isFinite(pressure) ? pressure : 0.5, 0.03, 1);
    speed = clamp(Number.isFinite(speed) ? speed : 0, 0, 8);
    size = clamp(Number.isFinite(size) ? size : 12, 0.5, 70);
    holdSeconds = clamp(Number.isFinite(holdSeconds) ? holdSeconds : 18, 4, 120);
    const flick = clamp((speed - 0.45) / 2.2, 0, 1);
    const radius = size * (0.42 + pressure * 0.75) * (1 - flick * 0.18) / bounds.height;
    const previousX = clamp(x - dx / bounds.width, -0.1, 1.1);
    const previousY = clamp(y - dy / bounds.height, -0.1, 1.1);
    if (this.engine) {
      const force = (1.8 + flick * 5) * waterModes[this.waterMode].current;
      this.engine.brush(x, 1 - y, previousX, 1 - previousY,
        radius, 0.85 + pressure * 2,
        clamp(dx * force, -190, 190), clamp(-dy * force, -190, 190), flick, holdSeconds);
      if (this.paused || this.reducedMotion) this.engine.render();
    } else {
      this.fallbackMarks.push({ x, y, px: previousX, py: previousY, radius, pressure, inkTime: this.writingClock });
      this.pruneBrushHistory();
      this.requestFallbackRender();
    }
  }

  clearWriting() {
    this.fallbackMarks.length = 0;
    this.brushHistory.length = 0;
    this.brushHistoryCount = 0;
    this.writingCheckpoint = null;
    this.resetBrushMask();
    if (this.engine) {
      this.engine.clearWriting();
      this.engine.render();
    } else {
      this.renderFallback();
    }
  }

  clear() {
    this.fallbackMarks.length = 0;
    this.brushHistory.length = 0;
    this.brushHistoryCount = 0;
    this.writingCheckpoint = null;
    this.resetBrushMask();
    this.ambientAmount = 0;
    this.ambientTrail.length = 0;
    this.trailDose = 0;
    this.emissionResumeAt = this.ambientAge + 2.4;
    this.nextTrailSample = this.emissionResumeAt;
    if (this.engine) {
      this.engine.clear();
      this.engine.render();
    } else {
      this.renderFallback();
    }
  }

  tick(now) {
    if (!this.active || ((this.paused || this.reducedMotion) && !this.writingFlow)) return;
    const elapsed = clamp((now - this.lastFrame) / 1000, 0, .25);
    const dt = Math.min(elapsed, 1 / 30);
    this.lastFrame = now;
    const animateFluid = !this.paused && !this.reducedMotion;
    const mode = waterModes[this.waterMode];
    const writingElapsed = elapsed * mode.fade;
    this.writingClock += writingElapsed;
    if (animateFluid) {
      this.time += dt * mode.drift;
      this.ambientAge += dt;
      if (this.ambientAge >= this.emissionResumeAt) {
        this.ambientAmount = Math.min(1, this.ambientAmount + dt * .16);
      }
      this.emitMovingInk(dt);
    }
    if (this.engine) {
      this.flushBrushMask();
      if (animateFluid) this.engine?.step(dt, writingElapsed);
      else this.engine?.stepWriting(writingElapsed);
      this.engine?.render();
    } else if (!this.lastFallbackFrame || now - this.lastFallbackFrame > 80) {
      this.renderFallback();
      this.lastFallbackFrame = now;
    }
    this.frame = requestAnimationFrame(this.tick);
  }
}
