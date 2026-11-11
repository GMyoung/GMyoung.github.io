'use strict';

// The video is the clock. HLS owns synchronized alternate audio; original MP4s
// keep the external-track fallback without downloading an inaudible second track.
class CinemaPlayer {
  constructor(root) {
    this.root = root;
    this.video = root.querySelector('video');
    this.controls = root.querySelector('.transport');
    this.status = root.querySelector('#player-status');
    this.playButton = root.querySelector('#play-pause');
    this.seek = root.querySelector('#seek');
    this.volume = root.querySelector('#volume');
    this.muteButton = root.querySelector('#mute');
    this.theaterButton = root.querySelector('#theater-toggle');
    this.fullscreenButton = root.querySelector('#fullscreen-toggle');
    this.buttons = [...root.querySelectorAll('[data-audio-track]')];
    this.audioToggle = root.querySelector('#audio-toggle');
    this.audio = Object.fromEntries(['original', 'karaoke'].map(name => {
      const audio = document.createElement('audio');
      audio.id = `audio-${name}`;
      audio.preload = 'none';
      audio.crossOrigin = 'anonymous';
      audio.hidden = true;
      audio.volume = .5;
      audio.volumeCanFade = Math.abs(audio.volume - .5) < .01;
      audio.volume = 0;
      audio.muted = true;
      root.append(audio);
      return [name, audio];
    }));
    this.baseVolume = .85;
    this.muted = false;
    this.active = 'karaoke';
    this.usingAudio = false;
    this.intentPlaying = false;
    this.generation = 0;
    this.switchToken = 0;
    this.fadeToken = 0;
    this.playToken = 0;
    this.theater = false;
    this.descriptors = {};
    this.failed = new Set();
    this.usingStream = false;
    this.stream = window.AdaptiveStream ? new AdaptiveStream(this) : null;
    this.volume.hidden = !Object.values(this.audio).every(audio => audio.volumeCanFade);
    this.bind();
    this.lyrics = window.LyricPreview ? new LyricPreview(root, this.video) : null;
    window.initCinemaFullscreen?.(this);
    this.timer = setInterval(() => this.sync(), 200);
  }

  bind() {
    this.playButton.addEventListener('click', () => this.togglePlay());
    this.video.addEventListener('click', () => this.togglePlay());
    this.seek.addEventListener('input', () => this.seekTo(Number(this.seek.value)));
    this.volume.addEventListener('input', () => {
      this.baseVolume = Number(this.volume.value);
      this.muted = this.baseVolume === 0;
      this.applyVolumes(false);
    });
    this.muteButton.addEventListener('click', () => {
      this.muted = !this.muted;
      this.applyVolumes(false);
    });
    this.root.querySelector('#playback-rate').addEventListener('change', event => {
      this.video.playbackRate = Number(event.target.value);
    });
    this.buttons.forEach(button => button.addEventListener('click', () => this.switchTrack(button.dataset.audioTrack)));
    this.audioToggle?.addEventListener('click', () => {
      const current = this.pending || this.active;
      this.switchTrack(current === 'original' ? 'karaoke' : 'original');
    });
    this.theaterButton.addEventListener('click', () => this.setTheater(!this.theater));
    this.video.addEventListener('play', () => {
      this.intentPlaying = true;
      this.updateTransport();
    });
    this.video.addEventListener('playing', () => {
      this.waiting = false;
      this.loadingSource = false;
      if (this.usingAudio) this.resumeAudio();
      if (!this.pending && !this.audioHold) this.message('');
      this.updateTransport();
    });
    this.video.addEventListener('pause', () => {
      if (!this.video.seeking && !this.audioHold && !this.loadingSource) this.intentPlaying = false;
      this.pauseAudio();
      this.updateTransport();
    });
    this.video.addEventListener('waiting', () => {
      this.waiting = true;
      this.pauseAudio();
      if (this.intentPlaying && !this.pending) this.message('Buffering…');
    });
    this.video.addEventListener('seeking', () => {
      this.pauseAudio();
      this.sync(true);
      this.updateTransport();
    });
    this.video.addEventListener('seeked', () => {
      this.sync(true);
      if (this.intentPlaying && !this.video.paused) this.resumeAudio();
      this.updateTransport();
    });
    this.video.addEventListener('ratechange', () => this.sync(true));
    this.video.addEventListener('loadedmetadata', () => { this.sync(true); this.updateTransport(); });
    this.video.addEventListener('timeupdate', () => this.updateTransport());
    this.video.addEventListener('ended', () => { this.intentPlaying = false; this.pauseAudio(); this.updateTransport(); });
    for (const [name, audio] of Object.entries(this.audio)) {
      audio.addEventListener('loadedmetadata', () => this.syncAudio(audio, true));
      audio.addEventListener('playing', () => {
        this.syncAudio(audio);
        if (name === this.active && !this.pending) this.message('');
      });
      audio.addEventListener('error', () => {
        if (this.usingAudio && name === this.active && !this.pending) this.fallback();
      });
      audio.addEventListener('waiting', () => {
        if (!this.usingAudio || name !== this.active || !this.intentPlaying || this.video.seeking || this.video.paused) return;
        this.audioHold = performance.now();
        this.video.pause();
        this.pauseAudio();
        this.message('Buffering soundtrack…');
      });
      audio.addEventListener('canplay', () => { if (name === this.active) this.resumeAfterAudioBuffer(); });
    }
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.sync(true); });
    document.addEventListener('keydown', event => this.keydown(event));
    this.root.addEventListener('click', event => {
      if (this.theater && event.target === this.root) this.setTheater(false);
    });
  }

  open(entry, url, autoplay = true) {
    this.openFocus = document.activeElement;
    this.pause();
    this.entry = entry;
    this.lyrics?.open(entry);
    this.originalUrl = url;
    this.failed = new Set();
    this.descriptors = entry.audio || {};
    this.active = this.descriptors[entry.defaultAudio] ? entry.defaultAudio :
      (this.descriptors.karaoke ? 'karaoke' : 'original');
    this.stream?.configure(entry, url);
    this.video.poster = entry.poster || '';
    this.setSource(this.stream?.supported ? 'auto' : 'original', 0, autoplay);
  }

  setSource(quality, position = 0, autoplay = true) {
    const generation = ++this.generation;
    this.playToken += 1;
    this.switchToken += 1;
    this.fadeToken += 1;
    this.loadingSource = true;
    this.audioHold = null;
    this.waiting = false;
    this.pending = null;
    this.intentPlaying = autoplay;
    this.video.pause();
    if (this.restorePosition) this.video.removeEventListener('loadedmetadata', this.restorePosition);
    this.restorePosition = null;
    for (const [name, audio] of Object.entries(this.audio)) {
      audio.pause();
      audio.removeAttribute('src');
      audio.preload = 'none';
      audio.volume = 0;
      audio.muted = true;
      audio.load();
    }
    this.usingStream = Boolean(this.stream?.supported && quality !== 'original');
    this.usingAudio = !this.usingStream && Boolean(this.descriptors[this.active]);
    this.video.muted = this.usingAudio;
    this.video.controls = false;
    this.controls.hidden = false;
    this.root.querySelector('.soundtracks').hidden = !this.usingAudio && !this.usingStream;
    this.message('');
    this.updateButtons();
    this.applyVolumes(false);
    this.updateTransport();
    const started = this.stream?.start(quality, position, this.active, () => {
      if (generation !== this.generation) return;
      if (this.intentPlaying) this.play(); else this.loadingSource = false;
    }, () => {
      if (generation !== this.generation) return;
      const time = this.video.currentTime || position;
      const resume = this.intentPlaying;
      this.setSource('original', time, resume);
      this.message('Adaptive video could not load. Using the original video.');
    });
    if (started) return;
    this.usingStream = false;
    if (this.usingAudio) this.ensureAudio(this.active);
    this.restorePosition = () => {
      if (generation !== this.generation) return;
      if (position > 0 && Number.isFinite(this.video.duration)) this.video.currentTime = Math.min(position, this.video.duration);
      this.sync(true);
      if (!this.intentPlaying) this.loadingSource = false;
    };
    this.video.addEventListener('loadedmetadata', this.restorePosition, { once: true });
    this.video.src = this.originalUrl;
    this.video.load();
    if (autoplay) this.play();
  }

  changeQuality(quality) {
    if (!this.entry) return;
    if (this.stream?.changeInPlace(quality)) return;
    this.setSource(quality, this.video.currentTime || 0, this.intentPlaying);
  }

  ensureAudio(name) {
    const audio = this.audio[name];
    if (audio && this.descriptors[name] && !audio.getAttribute('src')) {
      audio.preload = 'auto';
      audio.src = this.descriptors[name];
      audio.load();
    }
    return audio;
  }

  async play() {
    if (this.video.ended) this.seekTo(0);
    const generation = this.generation;
    const playToken = ++this.playToken;
    this.intentPlaying = true;
    this.updateTransport();
    try {
      if (this.usingAudio) {
        this.ensureAudio(this.active);
        this.sync(true);
        // Only the selected track runs; switching is another explicit gesture.
        const active = this.active;
        const result = this.audio[active].play();
        if (result) result.catch(error => {
          if (generation === this.generation && playToken === this.playToken && active === this.active && error.name !== 'AbortError' && this.intentPlaying) this.fallback();
        });
      }
      await this.video.play();
      if (generation !== this.generation || playToken !== this.playToken) return;
      this.sync(true);
      this.applyVolumes(false);
    } catch (error) {
      if (generation === this.generation && playToken === this.playToken) {
        if (this.audioHold || (error.name === 'AbortError' && !this.intentPlaying)) return;
        this.intentPlaying = false;
        this.loadingSource = false;
        this.pauseAudio();
        this.message('Press Play to start playback.');
        this.updateTransport();
      }
    }
  }

  pause() {
    this.playToken += 1;
    this.intentPlaying = false;
    this.loadingSource = false;
    this.audioHold = null;
    this.video.pause();
    this.pauseAudio();
    this.updateTransport();
  }

  togglePlay() { if (this.intentPlaying) this.pause(); else this.play(); }
  pauseAudio() { Object.values(this.audio).forEach(audio => audio.pause()); }

  resumeAudio() {
    if (!this.usingAudio || this.video.paused || this.video.seeking) return;
    this.sync(true);
    const generation = this.generation;
    const name = this.active;
    if (this.descriptors[name] && !this.failed.has(name)) this.ensureAudio(name).play().catch(error => {
      if (generation === this.generation && error.name !== 'AbortError' && name === this.active && this.intentPlaying) this.fallback();
    });
  }

  resumeAfterAudioBuffer() {
    if (!this.audioHold || !this.usingAudio || !this.intentPlaying || this.video.seeking) return;
    const audio = this.audio[this.active];
    const time = this.video.currentTime;
    let available = false;
    for (let i = 0; i < audio.buffered.length; i++) {
      if (audio.buffered.start(i) <= time + .05 && audio.buffered.end(i) >= Math.min(time + .5, audio.duration - .05)) available = true;
    }
    if (available) { this.audioHold = null; this.play(); }
    else if (performance.now() - this.audioHold > 12000) this.fallback();
  }

  seekTo(time) {
    if (!Number.isFinite(this.video.duration)) return;
    if (this.audioHold) this.audioHold = performance.now();
    this.video.currentTime = Math.max(0, Math.min(time, this.video.duration));
    this.sync(true);
    this.updateTransport();
  }

  syncAudio(audio, force = false) {
    if (!audio.src || audio.readyState < 1 || audio.error) return;
    const target = Math.min(this.video.currentTime, Math.max(0, audio.duration - .005));
    if (!Number.isFinite(target)) return;
    const difference = audio.currentTime - target;
    const rate = this.video.playbackRate;
    if (force || Math.abs(difference) > .18) {
      if (Math.abs(difference) > .025) {
        try { audio.currentTime = target; } catch { /* Retry after metadata. */ }
      }
      audio.playbackRate = rate;
    } else {
      // Small clock errors are corrected without audible repeated seeking.
      audio.playbackRate = rate * (Math.abs(difference) > .035 ? 1 - Math.max(-.025, Math.min(.025, difference * .12)) : 1);
    }
  }

  sync(force = false) {
    if (this.root.hidden) return;
    this.stream?.updateStats();
    if (!this.usingAudio) return;
    if (this.audioHold) {
      if (force) this.syncAudio(this.audio[this.active], true);
      this.resumeAfterAudioBuffer();
      return;
    }
    if (!force && (this.video.paused || this.video.seeking)) return;
    this.syncAudio(this.audio[this.active], force);
    if (this.pending) this.syncAudio(this.audio[this.pending], force);
  }

  async switchTrack(name) {
    if ((!this.usingAudio && !this.usingStream) || !this.descriptors[name] || this.failed.has(name)) return;
    if (name === this.active && !this.pending) return;
    const token = ++this.switchToken;
    const audio = this.audio[name];
    this.pending = name;
    this.updateButtons();
    this.message(`Loading ${name === 'original' ? 'original vocals' : 'karaoke'}…`);
    try {
      if (this.usingStream) await this.stream.switchTrack(name);
      else {
        this.ensureAudio(name);
        this.syncAudio(audio, true);
        if (!this.video.paused && !this.waiting) await this.withTimeout(audio.play(), 12000);
        else await this.ready(audio);
      }
      if (token !== this.switchToken) return;
      if (this.usingAudio) this.syncAudio(audio, true);
      this.active = name;
      this.pending = null;
      this.applyVolumes(true);
      this.updateButtons();
      this.message('');
    } catch (error) {
      if (token !== this.switchToken) return;
      this.pending = null;
      if (this.usingStream && this.stream.mode === 'native') {
        this.active = name;
        this.setSource('original', this.video.currentTime || 0, this.intentPlaying);
        this.message('This browser uses the original video to switch soundtracks.');
        return;
      }
      if (error.name === 'AbortError') return;
      if (this.usingAudio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
      this.failed.add(name);
      this.updateButtons();
      this.message('That soundtrack is unavailable. Your current audio is still playing.');
    }
  }

  withTimeout(promise, milliseconds) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Soundtrack timed out')), milliseconds);
      Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
  }

  ready(audio) {
    if (audio.error) return Promise.reject(audio.error);
    // A paused switch only needs a seekable timeline. Decoded data may not be
    // requested until Play, and loadeddata is not fired again after each seek.
    if (audio.readyState >= 1) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const clean = () => { clearTimeout(timer); audio.removeEventListener('loadedmetadata', success); audio.removeEventListener('error', fail); };
      const success = () => { clean(); resolve(); };
      const fail = () => { clean(); reject(new Error('Audio unavailable')); };
      const timer = setTimeout(fail, 12000);
      audio.addEventListener('loadedmetadata', success, { once: true });
      audio.addEventListener('error', fail, { once: true });
    });
  }

  fallback() {
    if (!this.usingAudio) return;
    const resume = this.intentPlaying;
    this.usingAudio = false;
    this.audioHold = null;
    this.switchToken += 1;
    this.pending = null;
    this.fadeToken += 1;
    this.pauseAudio();
    for (const audio of Object.values(this.audio)) { audio.removeAttribute('src'); audio.load(); }
    this.video.muted = this.muted;
    this.video.volume = this.baseVolume;
    this.video.controls = false;
    this.controls.hidden = false;
    this.root.querySelector('.soundtracks').hidden = true;
    this.message('Separate soundtracks could not load. The video’s included audio is playing.');
    if (resume && this.video.paused) this.play();
  }

  applyVolumes(fade) {
    this.video.muted = this.usingAudio || this.muted;
    this.video.volume = this.baseVolume;
    fade = fade && Object.values(this.audio).every(audio => audio.volumeCanFade);
    const token = ++this.fadeToken;
    const targets = Object.fromEntries(Object.keys(this.audio).map(name => [name, this.usingAudio && name === this.active && !this.muted ? this.baseVolume : 0]));
    const initial = Object.fromEntries(Object.entries(this.audio).map(([name, audio]) => [name, audio.volume]));
    for (const [name, audio] of Object.entries(this.audio)) {
      if (targets[name] > 0) audio.muted = false;
      else if (!fade || initial[name] === 0) audio.muted = true;
    }
    const start = performance.now();
    const step = now => {
      if (token !== this.fadeToken) return;
      const amount = fade ? Math.min(1, (now - start) / 100) : 1;
      for (const [name, audio] of Object.entries(this.audio)) {
        audio.volume = initial[name] + (targets[name] - initial[name]) * amount;
        if (amount === 1) audio.muted = targets[name] === 0;
        if (amount === 1 && name !== this.active && name !== this.pending) {
          audio.pause();
          if (audio.getAttribute('src')) { audio.removeAttribute('src'); audio.preload = 'none'; audio.load(); }
        }
      }
      if (amount < 1) requestAnimationFrame(step);
    };
    step(start);
    this.muteButton.textContent = this.muted ? 'Unmute' : 'Mute';
    this.muteButton.setAttribute('aria-pressed', String(this.muted));
    this.volume.value = String(this.baseVolume);
  }

  updateButtons() {
    this.buttons.forEach(button => {
      const name = button.dataset.audioTrack;
      button.disabled = !this.descriptors[name] || this.failed.has(name);
      button.setAttribute('aria-pressed', String(name === this.active));
      button.setAttribute('aria-busy', String(name === this.pending));
    });
    if (this.audioToggle) {
      const next = (this.pending || this.active) === 'original' ? 'karaoke' : 'original';
      const available = Boolean(this.descriptors[next]) && !this.failed.has(next);
      const currentLabel = this.active === 'original' ? 'Original vocals' : 'Karaoke';
      const nextLabel = next === 'original' ? 'original vocals' : 'karaoke';
      this.audioToggle.disabled = !available;
      this.audioToggle.dataset.currentAudio = this.active;
      this.audioToggle.dataset.nextAudio = next;
      this.audioToggle.setAttribute('aria-busy', String(Boolean(this.pending)));
      this.audioToggle.setAttribute('aria-label', available ? `Switch to ${nextLabel}. Currently ${currentLabel.toLowerCase()}.` : `${nextLabel} unavailable. Currently ${currentLabel.toLowerCase()}.`);
      this.audioToggle.querySelector('.audio-toggle-current').textContent = `${currentLabel} playing`;
      this.audioToggle.querySelector('.audio-toggle-action').textContent = this.pending ? 'Switching audio…' : available ? `Switch to ${nextLabel}` : `${nextLabel} unavailable`;
    }
  }

  updateTransport() {
    const duration = Number.isFinite(this.video.duration) ? this.video.duration : 0;
    this.seek.max = String(duration || 1);
    this.seek.value = String(this.video.currentTime || 0);
    this.seek.setAttribute('aria-valuetext', `${this.format(this.video.currentTime)} of ${this.format(duration)}`);
    this.root.querySelector('#current-time').textContent = this.format(this.video.currentTime);
    this.root.querySelector('#total-time').textContent = this.format(duration);
    this.playButton.textContent = this.intentPlaying ? 'Pause' : (this.video.ended ? 'Replay' : 'Play');
  }

  format(seconds) { const value = Math.max(0, Math.floor(seconds || 0)); return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`; }
  message(value) { this.status.textContent = value; this.status.hidden = !value; }

  setTheater(enabled, restoreFocus = true) {
    if (enabled === this.theater || (enabled && this.root.hidden)) return;
    this.theater = enabled;
    this.root.classList.toggle('cinema', enabled);
    document.body.classList.toggle('cinema-open', enabled);
    this.theaterButton.textContent = enabled ? 'Exit theater' : 'Theater mode';
    this.theaterButton.setAttribute('aria-pressed', String(enabled));
    document.querySelectorAll('[data-cinema-background]').forEach(element => { element.inert = enabled; });
    if (enabled) {
      this.returnFocus = document.activeElement;
      this.root.setAttribute('role', 'dialog');
      this.root.setAttribute('aria-modal', 'true');
      this.theaterButton.focus();
    } else {
      this.root.removeAttribute('role');
      this.root.removeAttribute('aria-modal');
      if (restoreFocus && this.returnFocus?.isConnected) this.returnFocus.focus({ preventScroll: true });
    }
  }

  keydown(event) {
    if (this.root.hidden) return;
    if (event.key === 'Escape' && this.theater) { event.preventDefault(); this.setTheater(false); return; }
    if (this.theater && event.key === 'Tab') {
      const focusable = [...this.root.querySelectorAll('button:not(:disabled),input,select,[tabindex="0"]')].filter(element => element.getClientRects().length);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      return;
    }
    if (!this.root.contains(document.activeElement) || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if (event.code === 'Space' && document.activeElement === this.video) { event.preventDefault(); this.togglePlay(); }
    if (event.key.toLowerCase() === 'm') { event.preventDefault(); this.muted = !this.muted; this.applyVolumes(false); }
    if (event.key === 'ArrowRight') { event.preventDefault(); this.seekTo(this.video.currentTime + 5); }
    if (event.key === 'ArrowLeft') { event.preventDefault(); this.seekTo(this.video.currentTime - 5); }
  }

  async close() {
    this.pause();
    this.setTheater(false, false);
    const closeGeneration = ++this.generation;
    const fullscreenExit = this.fullscreen?.close();
    this.switchToken += 1;
    this.fadeToken += 1;
    this.stream?.stop();
    if (this.restorePosition) this.video.removeEventListener('loadedmetadata', this.restorePosition);
    this.restorePosition = null;
    this.entry = null;
    this.lyrics?.close();
    this.video.removeAttribute('src');
    this.video.load();
    for (const audio of Object.values(this.audio)) { audio.removeAttribute('src'); audio.load(); }
    this.root.hidden = true;
    await fullscreenExit;
    if (closeGeneration !== this.generation) return;
    if (this.openFocus?.isConnected) this.openFocus.focus({preventScroll:true});
  }
}
window.CinemaPlayer = CinemaPlayer;
