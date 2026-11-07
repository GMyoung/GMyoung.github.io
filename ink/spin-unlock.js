import { IntroVortex } from './vortex.js';

const TAU = Math.PI * 2;
const DURATION = 2100;
const REQUIRED_SWEEP = TAU * .7;
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));

// A gentle partial circle and about two seconds of moving input open the title.
// Timing comes from input samples, never from merely holding a pointer down.
export class SpinUnlock {
  constructor({ intro, onUnlock, audio, reducedMotion = false }) {
    this.intro = intro;
    this.onUnlock = onUnlock;
    this.audio = audio;
    this.reducedMotion = reducedMotion;
    this.wrapper = document.querySelector('#spin-unlock');
    this.button = document.querySelector('#spin-button');
    this.canvas = document.querySelector('#spin-effects');
    this.context = this.canvas.getContext('2d');
    this.hint = document.querySelector('#spin-hint');
    this.status = document.querySelector('#spin-status');
    this.frame = 0;
    this.pointer = null;
    this.key = null;
    this.suppressedKey = null;
    this.suspended = false;
    this.active = true;
    this.center = { x: innerWidth / 2, y: innerHeight / 2, radius: 112 };
    this.vortex = new IntroVortex(document.querySelector('#intro-vortex'), { reducedMotion });

    this.button.addEventListener('pointerdown', event => this.press(event));
    this.button.addEventListener('pointermove', event => this.move(event));
    this.button.addEventListener('pointerup', event => this.releasePointer(event));
    this.button.addEventListener('pointercancel', event => this.releasePointer(event));
    this.button.addEventListener('lostpointercapture', event => this.releasePointer(event));
    this.button.addEventListener('click', event => event.preventDefault());
    this.button.addEventListener('contextmenu', event => event.preventDefault());
    this.button.addEventListener('keydown', event => this.keyDown(event));
    // Completion may focus the next control while a key is still held.
    // Keep consuming that original hold until its keyup, even after hiding.
    window.addEventListener('keydown', event => {
      if (event.key === this.suppressedKey) {
        // A fresh physical press also ends suppression if keyup was lost to
        // another window. Repeats from the completed hold remain consumed.
        if (!event.repeat) {
          this.suppressedKey = null;
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
    window.addEventListener('keyup', event => this.keyUp(event), true);
    this.button.addEventListener('focus', () => {
      this.wrapper.classList.toggle('keyboard-focus', this.button.matches(':focus-visible'));
      this.schedule();
    });
    this.button.addEventListener('blur', () => {
      this.wrapper.classList.remove('keyboard-focus');
      this.releaseKey();
    });
    window.addEventListener('blur', () => this.suspend());
    window.addEventListener('focus', () => this.resume());
    window.addEventListener('resize', () => {
      this.cancelHold();
      this.measure();
      this.renderVortex();
      this.schedule();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.suspend();
      else this.resume();
    });
    this.reset();
  }

  reset() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.cancelHold();
    this.state = 'locked';
    this.elapsed = 0;
    this.angle = 0;
    this.shaderAngle = 0;
    this.shaderTime = 0;
    this.inputVelocity = 0;
    this.velocity = 0;
    this.energy = 0;
    this.motion = 0;
    this.brushTrail = [];
    this.lastWakeSample = null;
    this.turnDirection = 1;
    this.directionChosen = false;
    this.lastInputKeyboard = false;
    this.direction = 0;
    this.reverseAngle = 0;
    this.reverseTime = 0;
    this.lastMovement = 0;
    this.releasedAt = 0;
    this.lastFrame = 0;
    this.lastAnnouncement = 0;
    this.shakeAmplitude = 0;
    this.wrapper.hidden = false;
    this.wrapper.classList.remove('is-spinning', 'is-unlocking', 'keyboard-focus');
    this.button.disabled = false;
    this.intro.style.transform = '';
    this.hint.textContent = '按住转圈，解锁 Harvey';
    this.status.textContent = '按住画面，围绕中央轻轻画圈约两秒。键盘可按住空格或回车约两秒。';
    this.audioCall('reset');
    this.measure();
    this.renderVortex();
    this.schedule();
  }

  setReducedMotion(value) {
    this.reducedMotion = value;
    this.vortex.setReducedMotion(value);
    if (value) {
      this.shakeAmplitude = 0;
      this.brushTrail = [];
      this.lastWakeSample = null;
    }
    this.intro.style.transform = '';
    this.renderVortex();
    this.schedule();
  }

  setActive(active) {
    this.active = Boolean(active);
    this.lastFrame = 0;
    if (!this.active) {
      this.cancelHold();
      cancelAnimationFrame(this.frame);
      this.frame = 0;
      this.inputVelocity = 0;
      this.velocity = 0;
      this.energy = 0;
      this.motion = 0;
      this.brushTrail = [];
      this.shakeAmplitude = 0;
      this.intro.style.transform = '';
      this.audioCall('stop');
      return;
    }
    this.renderVortex();
    this.schedule();
  }

  measure() {
    // The entire viewport accepts input, but the invisible pivot remains fixed.
    // It must never follow the hit target's dimensions or the screen tremor.
    this.center = { x: innerWidth / 2, y: innerHeight / 2, radius: Math.min(112, innerWidth * .26, innerHeight * .245) };
    this.ratio = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(innerWidth * this.ratio);
    this.canvas.height = Math.round(innerHeight * this.ratio);
    this.context.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    this.vortex.resize(innerWidth, innerHeight);
  }

  renderVortex() {
    const now = performance.now();
    this.brushTrail = this.brushTrail.filter(point => now - point.born < 850);
    const brushTrail = this.reducedMotion ? [] : this.brushTrail.map(point => ({
      x: point.x, y: point.y, dx: point.dx, dy: point.dy,
      weight: Math.pow(clamp(1 - (now - point.born) / 850), 1.25),
    }));
    this.vortex.render({ time: this.shaderTime, angle: this.shaderAngle, velocity: this.velocity, progress: this.progress(), energy: this.reducedMotion ? 0 : this.energy, brushTrail });
  }

  audioCall(method, value) {
    // Sound is an enhancement; unavailable audio must not block the gesture.
    try {
      const pending = this.audio?.[method]?.(value);
      pending?.catch?.(() => {});
    } catch {}
  }

  schedule() {
    if (!this.frame && this.active && !this.suspended && !document.hidden) {
      this.frame = requestAnimationFrame(now => this.tick(now));
    }
  }

  progress() {
    return Math.min(clamp(this.elapsed / DURATION), clamp(this.angle / REQUIRED_SWEEP));
  }

  press(event) {
    if (!this.active || this.state !== 'locked' || this.pointer !== null || this.key || !event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    this.measure();
    this.pointer = event.pointerId;
    this.lastSample = null;
    this.lastFrame = performance.now();
    this.lastMovement = 0;
    this.inputVelocity = 0;
    this.releasedAt = 0;
    this.lastInputKeyboard = false;
    this.wrapper.classList.remove('keyboard-focus');
    this.shakeAmplitude = Math.max(this.shakeAmplitude, .18);
    this.button.setPointerCapture(event.pointerId);
    this.wrapper.classList.add('is-spinning');
    this.hint.textContent = '围绕中央轻轻画圈';
    this.audioCall('start');
    this.sample(event);
    this.schedule();
  }

  move(event) {
    if (this.state !== 'locked' || event.pointerId !== this.pointer) return;
    event.preventDefault();
    const samples = event.getCoalescedEvents?.();
    for (const sample of samples?.length ? samples : [event]) this.sample(sample);
    this.schedule();
  }

  sample(event) {
    if (this.state !== 'locked') return;
    const x = event.clientX - this.center.x;
    const y = event.clientY - this.center.y;
    const radius = Math.hypot(x, y);
    const now = performance.now();
    const stamp = Number.isFinite(event.timeStamp) && Math.abs(event.timeStamp - now) < 60000 ? event.timeStamp : now;
    // Local ink responds to every plausible drag, including radial strokes and
    // motion through the center. Circular scoring remains independent below.
    this.sampleWake({ x: event.clientX, y: event.clientY, stamp });
    if (radius < clamp(this.center.radius * .17, 16, 24)) {
      this.lastSample = null;
      return;
    }
    const current = { x: event.clientX, y: event.clientY, radius, angle: Math.atan2(y, x), stamp };
    const previous = this.lastSample;
    this.lastSample = current;
    if (!previous) return;
    const dt = current.stamp - previous.stamp;
    const delta = Math.atan2(Math.sin(current.angle - previous.angle), Math.cos(current.angle - previous.angle));
    const speed = Math.abs(delta) / (dt / 1000);
    // Break continuity across dropped/teleported samples and the center deadzone.
    if (dt <= 0 || dt > 190 || Math.abs(delta) > .95 || speed > 24 ||
        Math.abs(radius - previous.radius) > Math.max(this.center.radius * .8, previous.radius * .75)) return;
    if (speed < .28 || Math.abs(delta) < .0004) return;
    if (!this.direction) this.direction = Math.sign(delta);
    const forward = delta * this.direction;
    if (forward > 0) {
      this.elapsed = Math.min(DURATION, this.elapsed + dt);
      this.angle = Math.min(REQUIRED_SWEEP * 3, this.angle + forward);
      this.reverseAngle = 0;
      this.reverseTime = 0;
    } else {
      // Tiny back-and-forth wiggles cannot bank forward-only rotation.
      this.elapsed = Math.max(0, this.elapsed - dt);
      this.angle = Math.max(0, this.angle + forward);
      this.reverseAngle -= forward;
      this.reverseTime += dt;
      if (this.reverseAngle > .55) {
        this.direction *= -1;
        this.elapsed = this.reverseTime;
        this.angle = this.reverseAngle;
        this.reverseAngle = 0;
        this.reverseTime = 0;
      }
    }
    if (now - this.lastMovement > 180) this.inputVelocity = 0;
    const measuredVelocity = clamp(delta / (dt / 1000), -18, 18);
    this.inputVelocity += (measuredVelocity - this.inputVelocity) * (1 - Math.exp(-dt / 55));
    this.lastMovement = now;
    if (!this.directionChosen && this.angle > .15) {
      this.turnDirection = this.direction;
      this.directionChosen = true;
    }
    if (this.progress() >= 1) this.complete(now);
  }

  sampleWake(current) {
    if (this.reducedMotion || !Number.isFinite(current.x) || !Number.isFinite(current.y)) return;
    const previous = this.lastWakeSample;
    if (previous && current.stamp <= previous.stamp) return;
    this.lastWakeSample = current;
    if (!previous) return;
    const dt = current.stamp - previous.stamp;
    const travelX = current.x - previous.x;
    const travelY = current.y - previous.y;
    const distance = Math.hypot(travelX, travelY);
    const shortEdge = Math.max(1, Math.min(innerWidth, innerHeight));
    // Break continuity across input gaps or cursor teleports; use the actual
    // event clock so coalesced events keep their proper ordering and spacing.
    if (dt > 190 || distance > Math.max(60, shortEdge * .35) || distance / dt > 10 || distance < .12) return;
    const magnitude = Math.min(.065, distance / shortEdge * 3);
    const point = {
      x: clamp(current.x / innerWidth), y: clamp(current.y / innerHeight),
      dx: travelX / distance * magnitude, dy: travelY / distance * magnitude,
      born: current.stamp,
    };
    const head = this.brushTrail[this.brushTrail.length - 1];
    const reversed = head && point.dx * head.dx + point.dy * head.dy < 0;
    if (!head || current.stamp - head.sampledAt >= 16 ||
        Math.hypot(current.x - head.sampledX, current.y - head.sampledY) >= 4 || reversed) {
      this.brushTrail.push({ ...point, sampledAt: current.stamp, sampledX: current.x, sampledY: current.y });
      if (this.brushTrail.length > 6) this.brushTrail.shift();
    } else {
      // The newest contact is never throttled: even sub-sample changes and
      // direction reversals reach the next rendered frame immediately.
      Object.assign(head, point);
    }
  }

  releasePointer(event) {
    if (event.pointerId !== this.pointer) return;
    this.cancelHold();
    this.schedule();
  }

  keyDown(event) {
    if (![' ', 'Enter'].includes(event.key)) return;
    event.preventDefault();
    if (!this.active || this.state !== 'locked' || this.pointer !== null || this.key || event.repeat) return;
    this.key = event.key;
    this.lastFrame = performance.now();
    this.lastMovement = this.lastFrame;
    this.releasedAt = 0;
    this.lastInputKeyboard = true;
    this.wrapper.classList.add('keyboard-focus');
    this.shakeAmplitude = Math.max(this.shakeAmplitude, .18);
    this.wrapper.classList.add('is-spinning');
    this.hint.textContent = '继续按住，约两秒解锁';
    this.audioCall('start');
    this.schedule();
  }

  keyUp(event) {
    if (event.key === this.suppressedKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.suppressedKey = null;
      return;
    }
    if (event.key !== this.key) return;
    event.preventDefault();
    this.releaseKey();
  }

  releaseKey() {
    if (!this.key) return;
    this.cancelHold();
    this.schedule();
  }

  cancelHold() {
    const pointer = this.pointer;
    const wasHeld = pointer !== null || this.key !== null;
    this.pointer = null;
    this.key = null;
    this.lastSample = null;
    this.lastWakeSample = null;
    this.releasedAt = performance.now();
    if (pointer !== null && this.button.hasPointerCapture(pointer)) this.button.releasePointerCapture(pointer);
    this.wrapper.classList.remove('is-spinning');
    if (wasHeld) this.audioCall('release');
  }

  suspend() {
    this.suspended = true;
    this.cancelHold();
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.lastFrame = 0;
    this.shakeAmplitude = 0;
    this.inputVelocity = 0;
    this.velocity = 0;
    this.energy = 0;
    this.motion = 0;
    this.brushTrail = [];
    this.intro.style.transform = '';
    this.audioCall('stop');
    // Hidden-tab time is never credited, including the final reveal flourish.
    if (this.state === 'releasing') this.reset();
  }

  resume() {
    if (document.hidden) return;
    this.suspended = false;
    this.lastFrame = 0;
    this.schedule();
  }

  complete(now) {
    if (this.state !== 'locked') return;
    this.state = 'releasing';
    this.releaseStart = now;
    this.lastInputKeyboard = this.key !== null;
    this.suppressedKey = this.key;
    this.cancelHold();
    this.button.disabled = true;
    this.wrapper.classList.add('is-unlocking');
    this.hint.textContent = '解锁成功';
    this.status.textContent = '已解锁 Harvey';
    this.schedule();
  }

  tick(now) {
    this.frame = 0;
    if (!this.active || this.suspended || document.hidden) return;
    const dt = this.lastFrame ? clamp(now - this.lastFrame, 0, 64) : 0;
    this.lastFrame = now;
    if (this.state === 'locked') {
      if (this.key) {
        this.elapsed = Math.min(DURATION, this.elapsed + dt);
        this.angle = Math.min(REQUIRED_SWEEP, this.angle + dt / DURATION * REQUIRED_SWEEP);
        this.lastMovement = now;
        if (this.progress() >= 1) this.complete(now);
      } else {
        const grace = this.pointer === null ? 800 : 300;
        const idleFrom = this.pointer === null ? Math.max(this.releasedAt, this.lastMovement) : this.lastMovement;
        if (now - idleFrom > grace) {
          this.elapsed = Math.max(0, this.elapsed - dt * .95);
          this.angle = Math.max(0, this.angle - dt / DURATION * REQUIRED_SWEEP * .95);
          if (this.elapsed === 0 || this.angle === 0) {
            this.elapsed = 0;
            this.angle = 0;
            this.direction = 0;
            this.reverseAngle = 0;
            this.reverseTime = 0;
          }
        }
      }
    }
    const progress = this.progress();
    const moving = this.key || (this.pointer !== null && now - this.lastMovement < 220);
    if (this.state === 'locked') {
      const text = moving ? (this.key ? '继续按住，约两秒解锁' : '轻轻画圈，约两秒解锁') :
        this.pointer !== null ? '围绕中央轻轻画圈' : progress > .02 ? '按住继续画圈，即可解锁' : '按住转圈，解锁 Harvey';
      if (this.hint.textContent !== text) this.hint.textContent = text;
      const milestone = Math.floor(progress * 4);
      if (milestone > this.lastAnnouncement && milestone < 4) {
        this.lastAnnouncement = milestone;
        this.status.textContent = `解锁进度 ${milestone * 25}%`;
      }
      if (progress === 0) this.lastAnnouncement = 0;
    }
    const activity = this.key ? .7 : moving ? clamp(Math.abs(this.inputVelocity) / 3) : 0;
    this.motion += (activity - this.motion) * (1 - Math.exp(-dt / (activity > this.motion ? 160 : 380)));
    if (this.motion < .001) this.motion = 0;
    // Drawing awakens the field. Progress gently raises its energy; raw hand
    // speed no longer dictates the scene's angle or forces sharp reversals.
    const energyTarget = moving ? clamp(.12 + progress * .76 + this.motion * .12) : 0;
    this.energy += (energyTarget - this.energy) * (1 - Math.exp(-dt / (energyTarget > this.energy ? 420 : 1300)));
    if (this.energy < .001) this.energy = 0;
    const breathing = .88 + .12 * Math.sin(this.shaderTime * .8 + .4);
    const velocityTarget = moving ? this.turnDirection * this.energy * (.12 + progress * .43) * breathing : 0;
    this.velocity += (velocityTarget - this.velocity) * (1 - Math.exp(-dt / (Math.abs(velocityTarget) > Math.abs(this.velocity) ? 650 : 1000)));
    if (Math.abs(this.velocity) < .001) this.velocity = 0;
    if (this.reducedMotion) {
      this.velocity = 0;
      this.energy = 0;
    }
    // Integrate angular displacement. Multiplying absolute time by the current
    // velocity would jump whenever a hand speeds up, reverses, or resumes.
    if (!this.reducedMotion) {
      this.shaderTime += dt / 1000;
      this.shaderAngle += this.velocity * dt / 1000;
    }
    this.renderVortex();
    const release = this.state === 'releasing' ? clamp((now - this.releaseStart) / 220) : 0;
    const held = this.pointer !== null || this.key !== null;
    this.audioCall('update', { progress, motion: moving ? this.motion : 0, energy: this.energy, held });
    const targetShake = this.reducedMotion || !held ? 0 : moving ? .12 + .72 * this.energy : .12;
    // The small contact tremor starts immediately, then settles smoothly when
    // the hand lifts. Its amplitude follows the actual gesture's progress.
    const response = 1 - Math.exp(-dt / (targetShake > this.shakeAmplitude ? 55 : 85));
    this.shakeAmplitude += (targetShake - this.shakeAmplitude) * response;
    if (this.reducedMotion || this.shakeAmplitude < .01) this.shakeAmplitude = 0;
    const shake = Math.min(1.5, this.shakeAmplitude) * (1 - release);
    const shakeX = shake * .86 * (Math.sin(now * .048) * .7 + Math.sin(now * .071) * .3);
    const shakeY = shake * .5 * (Math.cos(now * .052) * .75 + Math.sin(now * .081) * .25);
    this.intro.style.transform = shake ? `translate3d(${shakeX}px,${shakeY}px,0)` : '';
    if (this.state !== 'unlocked' && !this.wrapper.hidden) this.draw(now, progress, release);
    if (this.state === 'releasing' && release >= 1) {
      this.state = 'unlocked';
      this.intro.style.transform = '';
      this.audioCall('reveal');
      this.onUnlock({ keyboard: this.lastInputKeyboard });
    }
    if (!this.reducedMotion || held || (this.state === 'locked' && progress > 0) || this.state === 'releasing' || this.shakeAmplitude > 0) this.schedule();
  }

  draw(now, progress, release) {
    const ctx = this.context;
    const { x, y, radius } = this.center;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    const focused = this.wrapper.classList.contains('keyboard-focus');
    const scale = clamp(radius / 112, .52, 1);
    const gather = 1 - progress * .3;
    const motion = this.reducedMotion ? 0 : this.shaderAngle;
    for (let index = 0; index < 16; index++) {
      const spiral = index * .79 + Math.sin(index * 1.7) * .32;
      const orbit = spiral + motion * (.64 + (index % 4) * .08);
      const distance = radius * (.3 + index / 15 * 1.25) * gather;
      const floatAmplitude = (12 + index % 5 * 3) * Math.max(.75, scale);
      const driftX = this.reducedMotion ? 0 : Math.sin(this.shaderTime * (.43 + index % 3 * .08) + index * 1.9) * floatAmplitude;
      const driftY = this.reducedMotion ? 0 : Math.cos(this.shaderTime * (.51 + index % 4 * .06) + index * 2.1) * floatAmplitude * .84;
      const tumble = this.reducedMotion ? 0 : Math.sin(this.shaderTime * .46 + index * .9) * .18 + Math.cos(this.shaderTime * .71 + index * 1.2) * .09;
      const px = x + Math.cos(orbit) * distance + Math.sin(index * 2.4) * radius * .14 + driftX;
      const py = y + Math.sin(orbit) * distance * .81 + Math.cos(index * 1.3) * radius * .1 + driftY;
      const length = (15 + (index % 4) * 8 + Math.sin(index * 2) * 3) * scale;
      const width = (index % 3 === 2 ? 2.5 : 5 + index % 4 * 1.8) * scale;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(orbit + .55 + Math.sin(index * 2.8) * .8 + tumble);
      ctx.globalAlpha = (focused ? .95 : .65 + progress * .23) * (1 - release);
      const green = Math.round(96 + progress * 31 + index % 3 * 9);
      ctx.fillStyle = `rgb(${44 + index % 3 * 6},${green},${25 + index % 4 * 4})`;
      ctx.beginPath();
      if (index % 3 === 1) {
        // A tapered bristle fragment, with an imperfect split at the tip.
        ctx.moveTo(-length * .5, -width * .46);
        ctx.quadraticCurveTo(length * .12, -width * .65, length * .53, width * .2);
        ctx.lineTo(length * .3, width * .18);
        ctx.lineTo(length * .48, width * .4);
        ctx.quadraticCurveTo(-length * .1, width * .54, -length * .5, width * .4);
      } else {
        ctx.moveTo(-length * .5, -width * .32);
        ctx.lineTo(-length * .3, -width * .54);
        ctx.lineTo(length * .48, -width * .31);
        ctx.lineTo(length * .53, width * .29);
        ctx.lineTo(length * .31, width * .46);
        ctx.lineTo(-length * .47, width * .4);
      }
      ctx.closePath();
      ctx.fill();
      if (focused) {
        ctx.strokeStyle = '#234414';
        ctx.lineWidth = 1.25;
        ctx.stroke();
      }
      ctx.clip();
      ctx.lineCap = 'butt';
      ctx.lineWidth = Math.max(.5, scale * .7);
      for (let fiber = 0; fiber < 7; fiber++) {
        ctx.strokeStyle = fiber % 3 ? 'rgba(203,221,127,.3)' : 'rgba(24,62,16,.32)';
        const grainY = (fiber / 6 - .5) * width;
        ctx.beginPath();
        ctx.moveTo(-length * .48 + Math.sin(fiber + index) * 3 * scale, grainY);
        ctx.lineTo(length * (.2 + fiber % 3 * .12), grainY + Math.sin(fiber * 2.4 + index) * 1.7 * scale);
        ctx.stroke();
      }
      ctx.restore();
    }
  }
}

