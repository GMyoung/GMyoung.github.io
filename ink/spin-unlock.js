import { IntroVortex } from './vortex.js?v=1.19.0';
import { advanceLetterStep, LETTER_COUNT } from './wordmark-fragments.js?v=1.19.0';

const TAU = Math.PI * 2;
const DURATION = 7200;
const REQUIRED_SWEEP = TAU * 1.1;
const SPIN_HINT = '轻轻画圈，累计约七秒和一圈多一点';
const HOLD_HINT = '累计按住约七秒即可解锁';
const WHEEL_HINT = '用滚轮或触控板双指滚动，解锁 Harvey';
const WHEEL_TRAVEL = 1000;
const WHEEL_TIME = 4800;
const IDLE_SPEED = .07;
const GRIP_SLACK = .32;
const MAX_STRAIN = 1.1;
const TURN_SLACK = .20;
const TURN_STEP = 1 / 100;
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const smooth = value => {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
};

// Dragging requires a minimum sweep and sustained movement. Keyboard and
// wheel input advance the same sequence without tracing a circle.
export class SpinUnlock {
  constructor({ onUnlock, onSpinFrame, audio, reducedMotion = false }) {
    this.onUnlock = onUnlock;
    this.onSpinFrame = onSpinFrame;
    this.audio = audio;
    this.reducedMotion = reducedMotion;
    this.wrapper = document.querySelector('#spin-unlock');
    this.button = document.querySelector('#spin-button');
    this.hint = document.querySelector('#spin-hint');
    this.status = document.querySelector('#spin-status');
    this.meter = document.querySelector('#spin-progress');
    this.frame = 0;
    this.pointer = null;
    this.key = null;
    this.wheel = null;
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
    this.wrapper.addEventListener('wheel', event => this.roll(event), { passive: false });
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
      this.grip = null;
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
    this.letterStep = 0;
    this.clothAngle = 0;
    this.paintAngle = 0;
    this.shaderTime = 0;
    this.inputVelocity = 0;
    this.velocity = this.reducedMotion ? 0 : IDLE_SPEED;
    this.paintVelocity = this.velocity;
    this.coastDirection = 1;
    this.energy = 0;
    this.motion = 0;
    this.grip = null;
    this.lastInputKeyboard = false;
    this.direction = 0;
    this.reverseAngle = 0;
    this.lastMovement = 0;
    this.lastFrame = 0;
    this.lastAnnouncement = 0;
    this.shakeAmplitude = 0;
    this.shakePhase = 0;
    this.wrapper.hidden = false;
    this.wrapper.classList.remove('is-spinning', 'is-unlocking', 'keyboard-focus');
    this.button.disabled = false;
    this.hint.textContent = '按住转圈，解锁 Harvey';
    this.status.textContent = `${SPIN_HINT}，可以松手后继续。${WHEEL_HINT}。键盘可按住空格或回车。`;
    this.meter.value = 0;
    this.audioCall('reset');
    this.vortex.reset();
    this.measure();
    this.renderVortex();
    this.schedule();
  }

  setReducedMotion(value) {
    this.reducedMotion = value;
    this.vortex.setReducedMotion(value);
    if (value) {
      this.shakeAmplitude = 0;
      this.clothAngle = 0;
      this.paintAngle = 0;
      this.velocity = 0;
      this.paintVelocity = 0;
      this.grip = null;
    }
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
      this.paintVelocity = 0;
      this.energy = 0;
      this.motion = 0;
      this.grip = null;
      this.shakeAmplitude = 0;
      this.audioCall('stop');
      return;
    }
    this.renderVortex();
    if (this.state === 'locked' && !this.suspended) this.audioCall('start');
    this.schedule();
  }

  measure() {
    // The entire viewport accepts input, but the invisible pivot remains fixed.
    // It must never follow the hit target's dimensions or the screen tremor.
    this.center = { x: innerWidth / 2, y: innerHeight / 2, radius: Math.min(112, innerWidth * .26, innerHeight * .245) };
    this.vortex.resize(innerWidth, innerHeight);
  }

  renderVortex(shakeX = 0, shakeY = 0, dt = 0, release = 0) {
    const focused = this.wrapper.classList.contains('keyboard-focus');
    const progress = this.progress();
    const frame = {
      time: this.shaderTime, dt: dt / 1000, angle: this.clothAngle, velocity: this.velocity,
      paintAngle: this.paintAngle, paintVelocity: this.paintVelocity,
      progress, letterStep: this.reducedMotion ? 0 : this.letterStep,
      energy: this.energy, shakeX, shakeY, focused,
      grip: this.pointer !== null ? this.grip : null,
      marks: this.state === 'unlocked' ? 0 : (1 - release) * (focused ? .95 : .65 + progress * .23),
    };
    this.vortex.render(frame);
    this.onSpinFrame?.(frame);
  }

  audioCall(method, value) {
    // Sound is an enhancement; unavailable audio must not block the gesture.
    try {
      const pending = this.audio?.[method]?.(value);
      pending?.catch?.(() => {});
    } catch {}
  }

  schedule() {
    if (!this.frame && this.active && this.state !== 'unlocked' && !this.suspended && !document.hidden) {
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
    this.wheel = null;
    this.pointer = event.pointerId;
    this.lastSample = null;
    this.lastFrame = performance.now();
    this.lastMovement = 0;
    this.inputVelocity = 0;
    this.direction = 0;
    this.reverseAngle = 0;
    this.lastInputKeyboard = false;
    if (!this.reducedMotion) {
      this.grip = {
        x: clamp(event.clientX / innerWidth), y: clamp(event.clientY / innerHeight),
        stretch: 0, load: 0, follow: 0,
        strain: 0, kick: this.coastDirection * .17, last: null,
      };
    }
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
    this.sampleGrip({ x: event.clientX, y: event.clientY, stamp });
    if (radius < clamp(this.center.radius * .12, 9, 15)) {
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
    if (dt <= 0 || dt > 230 || Math.abs(delta) > 1.1 || speed > 30 ||
        Math.abs(radius - previous.radius) > Math.max(this.center.radius * .8, previous.radius * .75)) return;
    if (this.grip) this.grip.strain = clamp(this.grip.strain + delta, -MAX_STRAIN, MAX_STRAIN);
    if (speed < .18 || Math.abs(delta) < .0004) return;
    if (!this.direction) this.direction = Math.sign(delta);
    const forward = delta * this.direction;
    if (forward > 0) {
      // Recover any small backward motion before earning more progress.
      const earned = Math.max(0, forward - this.reverseAngle);
      this.reverseAngle = Math.max(0, this.reverseAngle - forward);
      this.elapsed = Math.min(DURATION, this.elapsed + dt * earned / forward);
      this.angle = Math.min(REQUIRED_SWEEP, this.angle + earned);
    } else {
      this.reverseAngle -= forward;
      if (this.reverseAngle > .55) {
        this.direction *= -1;
        this.reverseAngle = 0;
      }
    }
    const measuredVelocity = clamp(delta / (dt / 1000), -18, 18);
    if (!this.lastMovement || now - this.lastMovement > 180) this.inputVelocity = measuredVelocity;
    else this.inputVelocity += (measuredVelocity - this.inputVelocity) * (1 - Math.exp(-dt / 26));
    this.lastMovement = now;
    if (this.progress() >= 1) this.complete();
  }

  sampleGrip(current) {
    const grip = this.grip;
    if (!grip || !Number.isFinite(current.x) || !Number.isFinite(current.y)) return;
    const previous = grip.last;
    if (previous && current.stamp <= previous.stamp) return;
    grip.last = current;
    grip.x = clamp(current.x / innerWidth);
    grip.y = clamp(current.y / innerHeight);
    if (!previous) return;
    const dt = current.stamp - previous.stamp;
    const travelX = current.x - previous.x;
    const travelY = current.y - previous.y;
    const distance = Math.hypot(travelX, travelY);
    const shortEdge = Math.max(1, Math.min(innerWidth, innerHeight));
    if (dt > 190 || distance > Math.max(60, shortEdge * .35) || distance / dt > 10 || distance < .12) return;
    // Straight pulls bunch the cloth too. Only angular travel takes up slack
    // around the pivot and begins to turn the entire sheet.
    grip.stretch = clamp(grip.stretch + distance / (shortEdge * .13));
  }

  releasePointer(event) {
    if (event.pointerId !== this.pointer) return;
    this.cancelHold();
    this.schedule();
  }

  roll(event) {
    if (!this.active || this.suspended || this.state !== 'locked' || this.pointer !== null || this.key || event.ctrlKey || event.metaKey) return;
    const mode = event.deltaMode;
    const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (!Number.isFinite(delta) || delta === 0) return;
    const unit = mode === 1 ? 28 : mode === 2 ? innerHeight : 1;
    event.preventDefault();
    if (!this.wheel) {
      // Preserve completed progress when changing from a drag or key hold.
      const progress = this.progress();
      this.wheel = { distance: progress * WHEEL_TRAVEL, elapsed: progress * DURATION, direction: Math.sign(delta) };
      this.grip = null;
      this.audioCall('start');
    }
    this.wheel.distance = Math.min(WHEEL_TRAVEL, this.wheel.distance + Math.min(180, Math.abs(delta) * unit));
    this.wheel.direction = Math.sign(delta);
    this.schedule();
  }

  keyDown(event) {
    if (![' ', 'Enter'].includes(event.key)) return;
    event.preventDefault();
    if (!this.active || this.state !== 'locked' || this.pointer !== null || this.key || event.repeat) return;
    this.wheel = null;
    this.key = event.key;
    this.lastFrame = performance.now();
    this.lastMovement = this.lastFrame;
    this.lastInputKeyboard = true;
    this.wrapper.classList.add('keyboard-focus');
    this.shakeAmplitude = Math.max(this.shakeAmplitude, .18);
    this.wrapper.classList.add('is-spinning');
    this.hint.textContent = HOLD_HINT;
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
    const wasHeld = pointer !== null || this.key !== null || this.wheel !== null;
    this.pointer = null;
    this.key = null;
    this.wheel = null;
    this.lastSample = null;
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
    this.paintVelocity = 0;
    this.energy = 0;
    this.motion = 0;
    this.grip = null;
    this.audioCall('stop');
  }

  resume() {
    if (document.hidden || !this.active) return;
    this.suspended = false;
    this.lastFrame = 0;
    if (this.state === 'locked') this.audioCall('start');
    this.schedule();
  }

  complete() {
    if (this.state !== 'locked') return;
    this.state = 'releasing';
    this.releaseElapsed = 0;
    this.lastInputKeyboard = this.key !== null;
    this.suppressedKey = this.key;
    this.cancelHold();
    this.button.disabled = true;
    this.wrapper.classList.add('is-unlocking');
    this.hint.textContent = '解锁成功';
    this.status.textContent = '已解锁 Harvey';
    this.schedule();
  }

  pullCloth(grip, seconds, hand) {
    const steps = Math.max(1, Math.ceil(seconds / TURN_STEP));
    const step = seconds / steps;
    let turn = 0;
    for (let index = 0; index < steps; index++) {
      const stretch = grip.strain - clamp(grip.strain, -TURN_SLACK, TURN_SLACK);
      grip.follow = smooth(Math.abs(stretch) / .28);
      const force = stretch * (29 + 215 * grip.follow);
      // A soft catch moves the cloth a little. Tension adds traction, and a
      // fast pull slips enough for the spring to release its stored energy.
      const pace = Math.max(Math.abs(hand), Math.abs(this.velocity));
      const contact = 1.6 + grip.follow * (17 - 9 * smooth((pace - 3) / 4.5));
      const friction = contact + 3.6;
      const speedLimit = 1.1 + 9 * grip.follow;
      const target = clamp((force + contact * hand) / friction, -speedLimit, speedLimit);
      const before = this.velocity;
      this.velocity += (target - before) * (1 - Math.exp(-step * friction));
      const rotation = (before + this.velocity) * step / 2;
      grip.strain = clamp(grip.strain - rotation, -MAX_STRAIN, MAX_STRAIN);
      turn += rotation;
    }
    return turn;
  }

  turnCloth(dt, now, wheelDirection) {
    if (this.reducedMotion) {
      this.velocity = 0;
      this.paintVelocity = 0;
      this.energy = 0;
      return;
    }
    const grip = this.grip;
    const gripped = this.pointer !== null && Boolean(grip);
    const seconds = dt / 1000;
    const idle = this.state === 'locked' ? this.coastDirection * IDLE_SPEED : 0;
    let turn;
    if (gripped) {
      const hand = this.inputVelocity * (1 - smooth((now - this.lastMovement - 34) / 105));
      turn = this.pullCloth(grip, seconds, hand);
    } else {
      const warmup = smooth(this.elapsed / 2000);
      const speed = wheelDirection ? wheelDirection * (.75 + 2.6 * warmup) : this.key ? .75 + 1.6 * warmup : idle;
      const responseTime = wheelDirection ? 95 : this.key ? 74 : 355;
      this.velocity += (speed - this.velocity) * (1 - Math.exp(-dt / responseTime));
      turn = this.velocity * seconds;
    }
    if (Math.abs(this.velocity) < .001) this.velocity = 0;
    if ((gripped || this.key || wheelDirection) && Math.abs(this.velocity) > IDLE_SPEED) this.coastDirection = Math.sign(this.velocity);
    this.shaderTime += seconds * (gripped ? .27 : .8);

    if (grip) {
      // A short initial nudge acknowledges the catch.
      const kick = grip.kick * (1 - Math.exp(-dt / 84));
      grip.kick -= kick;
      turn += kick * .084;

      const load = gripped ? clamp(Math.max(Math.abs(grip.strain) / GRIP_SLACK, grip.stretch * .72)) : 0;
      grip.load += (load - grip.load) * (1 - Math.exp(-dt / (gripped ? 52 : 120)));
      grip.stretch *= Math.exp(-dt / 145);
      if (!gripped && Math.abs(grip.kick) < .003) this.grip = null;
    }
    this.clothAngle = (this.clothAngle + turn) % TAU;

    // The cloth carries the paint through its folds. The broad swirl picks up
    // speed from that motion and keeps its own momentum through a pause.
    const hardPull = smooth((Math.abs(this.velocity) - 2) / 4.6);
    let paintTarget = wheelDirection || this.key ? this.velocity : idle;
    if (gripped) paintTarget = this.velocity * (.52 + .40 * grip.follow + .18 * hardPull);
    const gainingSpeed = paintTarget * this.paintVelocity >= 0 && Math.abs(paintTarget) > Math.abs(this.paintVelocity);
    const response = gainingSpeed ? 270 - 110 * hardPull : 510;
    this.paintVelocity += (paintTarget - this.paintVelocity) * (1 - Math.exp(-dt / response));
    this.paintAngle = (this.paintAngle + this.paintVelocity * seconds) % TAU;
  }

  tick(now) {
    this.frame = 0;
    if (!this.active || this.suspended || document.hidden) return;
    const dt = this.lastFrame ? clamp(now - this.lastFrame, 0, 64) : 0;
    this.lastFrame = now;
    let wheelDirection = 0;
    if (this.state === 'locked') {
      if (this.key) {
        this.elapsed = Math.min(DURATION, this.elapsed + dt);
        this.angle = Math.min(REQUIRED_SWEEP, this.angle + dt / DURATION * REQUIRED_SWEEP);
        this.lastMovement = now;
        if (this.progress() >= 1) this.complete();
      } else if (this.wheel) {
        // Spend wheel distance gradually so one fast swipe cannot skip letters.
        const target = this.wheel.distance / WHEEL_TRAVEL * DURATION;
        const next = Math.min(target, this.wheel.elapsed + dt / WHEEL_TIME * DURATION);
        if (next > this.wheel.elapsed) wheelDirection = this.wheel.direction;
        this.wheel.elapsed = next;
        this.elapsed = Math.max(this.elapsed, next);
        this.angle = Math.max(this.angle, next / DURATION * REQUIRED_SWEEP);
        if (this.progress() >= 1) this.complete();
      }
    }
    const progress = this.progress();
    if (this.meter.value !== progress) this.meter.value = progress;
    const moving = this.key || wheelDirection || (this.pointer !== null && this.lastMovement > 0 && now - this.lastMovement < 145);
    this.letterStep = advanceLetterStep(this.letterStep, progress, dt, moving || this.state === 'releasing');
    if (this.state === 'locked') {
      const text = this.wheel ? WHEEL_HINT : moving ? (this.key ? HOLD_HINT : SPIN_HINT) :
        this.pointer !== null ? '围绕中央轻轻画圈' : progress > .02 ? '按住继续画圈，即可解锁' : '按住转圈，解锁 Harvey';
      if (this.hint.textContent !== text) this.hint.textContent = text;
      const milestone = Math.floor(progress * 4);
      if (milestone > this.lastAnnouncement && milestone < 4) {
        this.lastAnnouncement = milestone;
        this.status.textContent = `解锁进度 ${milestone * 25}%`;
      }
      if (progress === 0) this.lastAnnouncement = 0;
    }
    const activity = this.key ? .62 : wheelDirection ? .58 : moving ? clamp(Math.abs(this.inputVelocity) / 6) : 0;
    this.motion += (activity - this.motion) * (1 - Math.exp(-dt / (activity > this.motion ? 85 : 250)));
    if (this.motion < .001) this.motion = 0;
    const energyTarget = moving ? clamp(.16 + progress * .57 + this.motion * .28) : 0;
    this.energy += (energyTarget - this.energy) * (1 - Math.exp(-dt / (energyTarget > this.energy ? 120 : 590)));
    if (this.energy < .001) this.energy = 0;
    this.turnCloth(dt, now, wheelDirection);
    const lettersDone = this.reducedMotion || !this.vortex.fragments || this.letterStep === LETTER_COUNT;
    if (this.state === 'releasing' && lettersDone) this.releaseElapsed += dt;
    const release = this.state === 'releasing' ? clamp(this.releaseElapsed / 220) : 0;
    const held = this.pointer !== null || this.key !== null || wheelDirection !== 0;
    this.audioCall('update', { progress, motion: this.motion, held });
    const tension = progress ** 3;
    const pace = Math.sqrt(this.motion);
    // Keep contact light. The last stretch raises both the amplitude and tempo
    // of the same shared tremor, with the hand's speed setting its strength.
    const gripLoad = this.key ? 1 : wheelDirection ? .72 : this.grip?.load ?? 0;
    const targetShake = this.reducedMotion || !held ? 0 : .11 + gripLoad * (pace * (.95 + 3.35 * tension) + (moving ? tension * .66 : 0));
    const response = 1 - Math.exp(-dt / (targetShake > this.shakeAmplitude ? 62 : 115));
    this.shakeAmplitude += (targetShake - this.shakeAmplitude) * response;
    if (this.reducedMotion || this.shakeAmplitude < .01) this.shakeAmplitude = 0;
    const shake = Math.min(4.8, this.shakeAmplitude) * (1 - release);
    this.shakePhase = (this.shakePhase + TAU * (5.2 + 2.4 * this.motion + 1.35 * tension) * dt / 1000) % TAU;
    const phase = this.shakePhase;
    const shakeX = shake * (.80 * Math.sin(phase) + .20 * Math.cos(2 * phase + .4));
    const shakeY = shake * .60 * (.74 * Math.cos(phase + .25) + .26 * Math.sin(2 * phase + 1));
    this.renderVortex(shakeX, shakeY, dt, release);
    if (this.state === 'releasing' && release >= 1) {
      this.state = 'unlocked';
      this.onUnlock({ keyboard: this.lastInputKeyboard });
    }
    if (!this.reducedMotion || held || this.state === 'releasing' || this.shakeAmplitude > 0) this.schedule();
  }
}
