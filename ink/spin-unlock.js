import { IntroVortex } from './vortex.js?v=1.16.0';

const TAU = Math.PI * 2;
const DURATION = 2940;
const REQUIRED_SWEEP = TAU * .98;
const IDLE_SPEED = .16;
const GRIP_SLACK = .32;
const MAX_STRAIN = 1.1;
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));

// A near-full circle and about three seconds of moving input open the title.
// The idle turn is decorative. Progress comes from gesture samples or a key hold.
export class SpinUnlock {
  constructor({ onUnlock, audio, reducedMotion = false }) {
    this.onUnlock = onUnlock;
    this.audio = audio;
    this.reducedMotion = reducedMotion;
    this.wrapper = document.querySelector('#spin-unlock');
    this.button = document.querySelector('#spin-button');
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
    this.shaderAngle = 0;
    this.shaderTime = 0;
    this.inputVelocity = 0;
    this.velocity = this.reducedMotion ? 0 : IDLE_SPEED;
    this.coastDirection = 1;
    this.energy = 0;
    this.motion = 0;
    this.grip = null;
    this.lastInputKeyboard = false;
    this.direction = 0;
    this.reverseAngle = 0;
    this.reverseTime = 0;
    this.lastMovement = 0;
    this.releasedAt = 0;
    this.lastFrame = 0;
    this.lastAnnouncement = 0;
    this.shakeAmplitude = 0;
    this.shakePhase = 0;
    this.wrapper.hidden = false;
    this.wrapper.classList.remove('is-spinning', 'is-unlocking', 'keyboard-focus');
    this.button.disabled = false;
    this.hint.textContent = '按住转圈，解锁 Harvey';
    this.status.textContent = '按住画面，围绕中央转近一整圈，持续约三秒。键盘可按住空格或回车约三秒。';
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
      this.shaderAngle = 0;
      this.velocity = 0;
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
    this.vortex.render({
      time: this.shaderTime, dt: dt / 1000, angle: this.shaderAngle, velocity: this.velocity,
      energy: this.energy, shakeX, shakeY, focused,
      grip: this.pointer !== null ? this.grip : null,
      marks: this.state === 'unlocked' ? 0 : (1 - release) * (focused ? .95 : .72 + this.progress() * .16),
    });
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
    this.pointer = event.pointerId;
    this.lastSample = null;
    this.lastFrame = performance.now();
    this.lastMovement = 0;
    this.inputVelocity = 0;
    this.releasedAt = 0;
    this.lastInputKeyboard = false;
    if (!this.reducedMotion) {
      this.grip = {
        x: clamp(event.clientX / innerWidth), y: clamp(event.clientY / innerHeight),
        stretch: 0, load: 0,
        strain: 0, kick: this.coastDirection * .78, last: null,
      };
      this.velocity = 0;
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
    if (this.grip) this.grip.strain = clamp(this.grip.strain + delta, -MAX_STRAIN, MAX_STRAIN);
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
    const measuredVelocity = clamp(delta / (dt / 1000), -18, 18);
    if (!this.lastMovement || now - this.lastMovement > 180) this.inputVelocity = measuredVelocity;
    else this.inputVelocity += (measuredVelocity - this.inputVelocity) * (1 - Math.exp(-dt / 38));
    this.lastMovement = now;
    if (this.progress() >= 1) this.complete(now);
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
    this.hint.textContent = '继续按住，约三秒解锁';
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
    this.grip = null;
    this.audioCall('stop');
    // Hidden-tab time is never credited, including the final reveal flourish.
    if (this.state === 'releasing') this.reset();
  }

  resume() {
    if (document.hidden || !this.active) return;
    this.suspended = false;
    this.lastFrame = 0;
    if (this.state === 'locked') this.audioCall('start');
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

  turnCloth(dt) {
    if (this.reducedMotion) {
      this.velocity = 0;
      this.energy = 0;
      return;
    }
    const grip = this.grip;
    const gripped = this.pointer !== null && Boolean(grip);
    let speed = this.state === 'locked' ? this.coastDirection * IDLE_SPEED : 0;
    if (this.key) speed = 2.35;
    else if (gripped) {
      const taut = grip.strain - clamp(grip.strain, -GRIP_SLACK, GRIP_SLACK);
      speed = clamp(taut * 16, -5.8, 5.8);
    }
    const damping = gripped ? 54 : this.key ? 74 : 310;
    this.velocity += (speed - this.velocity) * (1 - Math.exp(-dt / damping));
    if (Math.abs(this.velocity) < .001) this.velocity = 0;
    if ((gripped || this.key) && Math.abs(this.velocity) > IDLE_SPEED) this.coastDirection = Math.sign(this.velocity);
    const seconds = dt / 1000;
    let turn = this.velocity * seconds;
    this.shaderTime += seconds * (gripped ? .27 : .8);

    if (grip) {
      // A short initial nudge acknowledges the catch. Traction then consumes
      // the stored angular strain as the fabric catches up to the hand.
      if (gripped) grip.strain = clamp(grip.strain - turn, -MAX_STRAIN, MAX_STRAIN);
      const kick = grip.kick * (1 - Math.exp(-dt / 84));
      grip.kick -= kick;
      turn += kick * .084;

      const load = gripped ? clamp(Math.max(Math.abs(grip.strain) / GRIP_SLACK, grip.stretch * .72)) : 0;
      grip.load += (load - grip.load) * (1 - Math.exp(-dt / (gripped ? 52 : 120)));
      grip.stretch *= Math.exp(-dt / 145);
      if (!gripped && Math.abs(grip.kick) < .003) this.grip = null;
    }
    this.shaderAngle = (this.shaderAngle + turn) % TAU;
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
    const moving = this.key || (this.pointer !== null && this.lastMovement > 0 && now - this.lastMovement < 145);
    if (this.state === 'locked') {
      const text = moving ? (this.key ? '继续按住，约三秒解锁' : '持续画圈约三秒，转近一整圈') :
        this.pointer !== null ? '围绕中央轻轻画圈' : progress > .02 ? '按住继续画圈，即可解锁' : '按住转圈，解锁 Harvey';
      if (this.hint.textContent !== text) this.hint.textContent = text;
      const milestone = Math.floor(progress * 4);
      if (milestone > this.lastAnnouncement && milestone < 4) {
        this.lastAnnouncement = milestone;
        this.status.textContent = `解锁进度 ${milestone * 25}%`;
      }
      if (progress === 0) this.lastAnnouncement = 0;
    }
    const activity = this.key ? .62 : moving ? clamp(Math.abs(this.inputVelocity) / 6) : 0;
    this.motion += (activity - this.motion) * (1 - Math.exp(-dt / (activity > this.motion ? 85 : 250)));
    if (this.motion < .001) this.motion = 0;
    const energyTarget = moving ? clamp(.16 + progress * .57 + this.motion * .28) : 0;
    this.energy += (energyTarget - this.energy) * (1 - Math.exp(-dt / (energyTarget > this.energy ? 120 : 590)));
    if (this.energy < .001) this.energy = 0;
    this.turnCloth(dt);
    const release = this.state === 'releasing' ? clamp((now - this.releaseStart) / 220) : 0;
    const held = this.pointer !== null || this.key !== null;
    this.audioCall('update', { progress, motion: this.motion, held });
    const tension = progress ** 3;
    const pace = Math.sqrt(this.motion);
    // Keep contact light. The last stretch raises both the amplitude and tempo
    // of the same shared tremor, with the hand's speed setting its strength.
    const gripLoad = this.key ? 1 : this.grip?.load ?? 0;
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
    if (!this.reducedMotion || held || (this.state === 'locked' && progress > 0) || this.state === 'releasing' || this.shakeAmplitude > 0) this.schedule();
  }
}
