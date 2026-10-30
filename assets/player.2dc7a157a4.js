'use strict';

// The video is the clock. Switching soundtracks never changes its source.
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
      audio.preload = 'auto';
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
    this.theater = false;
    this.volume.hidden = !Object.values(this.audio).every(audio => audio.volumeCanFade);
    this.bind();
    this.timer = setInterval(() => this.sync(), 200);
  }

  bind() {
    this.playButton.addEventListener('click', () => this.togglePlay());
    this.video.addEventListener('click', () => { if (this.usingAudio) this.togglePlay(); });
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
    this.fullscreenButton.addEventListener('click', async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await this.root.requestFullscreen();
      } catch { this.message('Full screen is not available in this browser.'); }
    });
    document.addEventListener('fullscreenchange', () => {
      this.fullscreenButton.textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen';
    });
    this.video.addEventListener('play', () => {
      this.intentPlaying = true;
      this.updateTransport();
    });
    this.video.addEventListener('playing', () => {
      this.waiting = false;
      if (this.usingAudio) this.resumeAudio();
      this.updateTransport();
    });
    this.video.addEventListener('pause', () => {
      if (!this.video.seeking) this.intentPlaying = false;
      this.pauseAudio();
      this.updateTransport();
    });
    this.video.addEventListener('waiting', () => {
      this.waiting = true;
      this.pauseAudio();
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
    this.generation += 1;
    this.switchToken += 1;
    this.pending = null;
    this.failed = new Set();
    this.descriptors = entry.audio || {};
    this.usingAudio = Boolean(this.descriptors.original || this.descriptors.karaoke);
    this.active = this.descriptors[entry.defaultAudio] ? entry.defaultAudio :
      (this.descriptors.karaoke ? 'karaoke' : 'original');
    for (const [name, audio] of Object.entries(this.audio)) {
      audio.pause();
      audio.removeAttribute('src');
      audio.volume = 0;
      if (this.descriptors[name]) audio.src = this.descriptors[name];
      audio.load();
    }
    this.video.src = url;
    this.video.poster = entry.poster || '';
    this.video.muted = this.usingAudio;
    this.video.controls = !this.usingAudio;
    this.video.load();
    this.controls.hidden = !this.usingAudio;
    this.root.querySelector('.soundtracks').hidden = !this.usingAudio;
    this.message('');
    this.updateButtons();
    this.applyVolumes(false);
    this.updateTransport();
    if (autoplay) this.play();
  }

  async play() {
    if (this.video.ended) this.seekTo(0);
    const generation = this.generation;
    this.intentPlaying = true;
    try {
      if (this.usingAudio) {
        this.sync(true);
        // Start both within the user gesture. The unused track runs silently.
        for (const [name, audio] of Object.entries(this.audio)) {
          if (!this.descriptors[name] || this.failed.has(name)) continue;
          const result = audio.play();
          if (result) result.catch(() => {});
        }
      }
      await this.video.play();
      if (generation !== this.generation) return;
      this.sync(true);
      this.applyVolumes(false);
    } catch {
      if (generation === this.generation) {
        this.intentPlaying = false;
        this.pauseAudio();
        this.message('Press Play to start playback.');
        this.updateTransport();
      }
    }
  }

  pause() {
    this.intentPlaying = false;
    this.video.pause();
    this.pauseAudio();
    this.updateTransport();
  }

  togglePlay() { if (this.video.paused) this.play(); else this.pause(); }
  pauseAudio() { Object.values(this.audio).forEach(audio => audio.pause()); }

  resumeAudio() {
    if (!this.usingAudio || this.video.paused || this.video.seeking) return;
    this.sync(true);
    for (const [name, audio] of Object.entries(this.audio)) {
      if (this.descriptors[name] && !this.failed.has(name)) audio.play().catch(error => {
        if (error.name !== 'AbortError' && name === this.active && this.intentPlaying) this.fallback();
      });
    }
  }

  seekTo(time) {
    if (!Number.isFinite(this.video.duration)) return;
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
    if (!this.usingAudio || this.root.hidden) return;
    if (!force && (this.video.paused || this.video.seeking)) return;
    Object.values(this.audio).forEach(audio => this.syncAudio(audio, force));
  }

  async switchTrack(name) {
    if (!this.usingAudio || !this.descriptors[name] || this.failed.has(name)) return;
    if (name === this.active && !this.pending) return;
    const token = ++this.switchToken;
    const audio = this.audio[name];
    this.pending = name;
    this.updateButtons();
    this.message(`Loading ${name === 'original' ? 'original vocals' : 'karaoke'}…`);
    try {
      this.syncAudio(audio, true);
      if (!this.video.paused && !this.waiting) await audio.play();
      else await this.ready(audio);
      if (token !== this.switchToken) return;
      this.syncAudio(audio, true);
      this.active = name;
      this.pending = null;
      this.applyVolumes(true);
      this.updateButtons();
      this.message('');
    } catch {
      if (token !== this.switchToken) return;
      this.pending = null;
      this.failed.add(name);
      this.updateButtons();
      this.message('That soundtrack is unavailable. Your current audio is still playing.');
    }
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
    this.usingAudio = false;
    this.switchToken += 1;
    this.pauseAudio();
    this.video.muted = this.muted;
    this.video.volume = this.baseVolume;
    this.video.controls = true;
    this.controls.hidden = true;
    this.root.querySelector('.soundtracks').hidden = true;
    this.message('Separate soundtracks could not load. The video’s included audio is playing.');
  }

  applyVolumes(fade) {
    fade = fade && Object.values(this.audio).every(audio => audio.volumeCanFade);
    const token = ++this.fadeToken;
    const targets = Object.fromEntries(Object.keys(this.audio).map(name => [name, name === this.active && !this.muted ? this.baseVolume : 0]));
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
    this.playButton.textContent = this.video.paused ? (this.video.ended ? 'Replay' : 'Play') : 'Pause';
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
    if (document.fullscreenElement === this.root) await document.exitFullscreen().catch(() => {});
    this.generation += 1;
    this.switchToken += 1;
    this.video.removeAttribute('src');
    this.video.load();
    for (const audio of Object.values(this.audio)) { audio.removeAttribute('src'); audio.load(); }
    this.root.hidden = true;
    if (this.openFocus?.isConnected) this.openFocus.focus({preventScroll:true});
  }
}
window.CinemaPlayer = CinemaPlayer;
