// The score and title cue are local audio files. The only synthesized layer is
// the rising air, which follows the energy of the live gesture.
const ASSETS = {
  music: new URL('./assets/midnight-paper.mp3', import.meta.url),
  cheer: new URL('./assets/harvey-yay.mp3?v=1.16.0', import.meta.url),
};
const clamp = value => Math.max(0, Math.min(1, value));

export class IntroAudio {
  constructor(button) {
    this.button = button;
    this.Context = window.AudioContext || window.webkitAudioContext;
    this.phase = 'idle';
    this.muted = false;
    this.values = { progress: 0, motion: 0, held: false };
    this.tracks = new Set();
    this.buffers = {};
    this.button.hidden = !this.Context;
    if (!this.Context) return;

    // Fetch on arrival so a fast unlock does not have to wait for the files.
    this.files = Object.entries(ASSETS).map(([name, url]) => [name,
      fetch(url).then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.arrayBuffer();
      }).catch(error => {
        console.warn(`Could not load the intro ${name}`, error);
        return null;
      }),
    ]);
    this.button.addEventListener('click', () => {
      this.muted = this.phase !== 'idle' && this.context?.state === 'running' && !this.muted;
      if (this.phase === 'idle') this.phase = 'spinning';
      if (this.muted) this.syncPlayback();
      else this.resumePlayback();
    });
    // A touch pointerdown may not grant audio permission. Capture the release
    // even if completing the spin has already hidden the original hit target.
    const unlockTouchAudio = event => {
      if (event.isTrusted && !this.button.contains(event.target) && this.context?.state !== 'running') {
        this.resumePlayback();
      }
    };
    window.addEventListener('pointerup', event => {
      if (event.isPrimary && event.pointerType !== 'mouse') unlockTouchAudio(event);
    }, { capture: true, passive: true });
    window.addEventListener('touchend', unlockTouchAudio, { capture: true, passive: true });
    this.updateControl();
  }

  initialize() {
    const context = new this.Context({ latencyHint: 'interactive' });
    this.context = context;
    this.master = context.createGain();
    this.master.gain.value = 0;
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -9;
    limiter.ratio.value = 4;
    limiter.attack.value = .004;
    limiter.release.value = .15;
    this.master.connect(limiter).connect(context.destination);
    context.addEventListener('statechange', () => this.syncPlayback());

    for (const [name, file] of this.files) {
      file.then(bytes => bytes && context.decodeAudioData(bytes)).then(buffer => {
        if (!buffer) return;
        this.buffers[name] = buffer;
        this.syncPlayback();
      }).catch(error => console.warn(`Could not decode the intro ${name}`, error));
    }

    const noise = context.createBuffer(1, Math.round(context.sampleRate * 1.25), context.sampleRate);
    const samples = noise.getChannelData(0);
    let brown = 0;
    for (let index = 0; index < samples.length; index++) {
      const white = Math.random() * 2 - 1;
      brown = (brown + .045 * white) / 1.045;
      samples[index] = .66 * white + 1.35 * brown;
    }
    this.noise = noise;
  }

  updateControl() {
    const audible = this.phase !== 'idle' && this.context?.state === 'running' && !this.muted;
    this.button.setAttribute('aria-pressed', String(audible));
  }

  resumePlayback() {
    if (!this.Context || this.phase === 'idle' || this.muted || document.hidden) return;
    if (!this.context) this.initialize();
    // Try on entry, then retry directly inside input events if autoplay needs
    // activation. Issue resume even if a suspend from the previous view is queued.
    const resumed = this.context.resume();
    if (this.context.state === 'running') this.syncPlayback();
    resumed.then(() => this.syncPlayback()).catch(() => this.updateControl());
  }

  start() {
    if (this.phase === 'idle') this.phase = 'spinning';
    this.resumePlayback();
  }

  play(buffer, { level, loop = false, filterType, frequency }) {
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.loop = loop;
    const gain = this.context.createGain();
    gain.gain.value = level;
    const filter = filterType ? this.context.createBiquadFilter() : null;
    if (filter) {
      filter.type = filterType;
      filter.frequency.value = frequency;
      if (filterType === 'bandpass') filter.Q.value = .82;
      source.connect(filter).connect(gain);
    } else {
      source.connect(gain);
    }
    gain.connect(this.master);
    const track = { source, gain, filter };
    this.tracks.add(track);
    source.onended = () => this.disconnect(track);
    source.start();
    return track;
  }

  disconnect(track) {
    track.source.onended = null;
    track.source.disconnect();
    track.filter?.disconnect();
    track.gain.disconnect();
    this.tracks.delete(track);
  }

  fade(track, duration) {
    if (!track) return;
    const now = this.context.currentTime;
    track.gain.gain.setTargetAtTime(0, now, duration / 5);
    track.source.stop(now + duration);
  }

  syncPlayback() {
    this.updateControl();
    if (this.phase === 'idle' || this.context?.state !== 'running' || document.hidden) return;
    this.master.gain.setTargetAtTime(this.muted ? 0 : .89, this.context.currentTime, .02);
    if (this.muted) return;
    if (this.phase === 'spinning') {
      this.air ??= this.play(this.noise, { level: 0, loop: true, filterType: 'bandpass', frequency: 540 });
      if (!this.music && this.buffers.music) {
        this.music = this.play(this.buffers.music, { level: 0, loop: true, filterType: 'lowpass', frequency: 5100 });
      }
      this.update(this.values);
    } else if (!this.playedCheer && this.buffers.cheer) {
      this.playedCheer = true;
      this.play(this.buffers.cheer, { level: 1 });
    }
  }

  update(values) {
    this.values = values;
    if (this.phase !== 'spinning' || this.context?.state !== 'running') return;
    const now = this.context.currentTime;
    const progress = clamp(values.progress);
    const motion = values.held ? Math.sqrt(clamp(values.motion)) : 0;
    const music = this.music;
    if (music && music.motion !== motion) {
      music.motion = motion;
      music.gain.gain.setTargetAtTime(.49 + .12 * motion, now, .09);
      music.filter.frequency.setTargetAtTime(5100 + 5400 * motion, now, .13);
    }
    const air = this.air;
    if (air && (air.progress !== progress || air.motion !== motion)) {
      air.progress = progress;
      air.motion = motion;
      air.filter.frequency.setTargetAtTime(540 * Math.pow(9, progress), now, .08);
      air.gain.gain.setTargetAtTime(motion * (.16 + progress * .19), now, motion ? .07 : .045);
    }
  }

  release() {
    this.update({ ...this.values, held: false, motion: 0 });
  }

  reveal() {
    if (this.phase !== 'spinning') return;
    this.phase = 'reveal';
    this.fade(this.music, .32);
    this.fade(this.air, .15);
    this.music = null;
    this.air = null;
    this.syncPlayback();
  }

  stop() {
    this.phase = 'idle';
    this.playedCheer = false;
    this.values = { progress: 0, motion: 0, held: false };
    if (this.context) {
      const now = this.context.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setValueAtTime(0, now);
      for (const track of this.tracks) {
        track.source.stop(now);
        this.disconnect(track);
      }
      this.music = null;
      this.air = null;
      this.context.suspend().catch(() => {});
    }
    this.updateControl();
  }

  reset() { this.stop(); }
}
