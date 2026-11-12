'use strict';

// Video-only HLS preserves adaptive quality. Audio sources load on demand;
// the second audible source follows the first, while video is the main clock.
class CinemaPlayer {
  constructor(root) {
    this.root = root;
    this.video = root.querySelector('video');
    this.controls = root.querySelector('.transport');
    this.status = root.querySelector('#player-status');
    this.playButton = root.querySelector('#play-pause');
    this.seek = root.querySelector('#seek');
    this.volume = root.querySelector('#volume');
    this.mixControl = root.querySelector('#vocal-mix');
    this.mixValue = root.querySelector('#vocal-mix-value');
    this.muteButton = root.querySelector('#mute');
    this.fullscreenButton = root.querySelector('#fullscreen-toggle');
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
    this.mix = this.requestedMix = 0;
    this.usingAudio = this.intentPlaying = false;
    this.generation = this.switchToken = this.playToken = 0;
    this.descriptors = {};
    this.failed = new Set();
    this.gains = {};
    this.preparing = {};
    this.trackAbort = {};
    this.stream = window.AdaptiveStream ? new AdaptiveStream(this) : null;
    this.bind();
    this.lyrics = window.LyricPreview ? new LyricPreview(root, this.video) : null;
    window.initCinemaFullscreen?.(this);
    this.timer = setInterval(() => this.sync(), 100);
  }

  // Each MediaElementSource is created once and retained across songs. Gain
  // nodes support browsers where changing HTMLMediaElement.volume is ignored.
  unlockAudio() {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!this.context && AudioContext) {
      try { this.context = new AudioContext(); } catch { /* Native volume fallback. */ }
    }
    if (this.context) {
      for (const [name, audio] of Object.entries(this.audio)) {
        if (this.gains[name]) continue;
        try {
          const gain = this.context.createGain();
          gain.gain.value = 0;
          const source = this.context.createMediaElementSource(audio);
          source.connect(gain).connect(this.context.destination);
          this.gains[name] = gain;
        } catch { /* A failed source keeps native volume control. */ }
      }
      if (this.context.state !== 'running') this.context.resume().catch(() => {
        if (this.intentPlaying) this.message('Press Play to enable sound.');
      });
    }
    this.applyVolumes();
    this.updateButtons();
  }

  names(mix = this.mix) {
    return [mix < 1 ? 'karaoke' : null, mix > 0 ? 'original' : null].filter(Boolean);
  }

  bind() {
    this.playButton.addEventListener('click', () => this.togglePlay());
    this.video.addEventListener('click', () => this.togglePlay());
    this.seek.addEventListener('input', () => this.seekTo(Number(this.seek.value)));
    this.volume.addEventListener('input', () => {
      this.baseVolume = Number(this.volume.value);
      this.muted = this.baseVolume === 0;
      this.unlockAudio();
    });
    this.mixControl?.addEventListener('input', () => this.setMix(Number(this.mixControl.value) / 100));
    this.muteButton.addEventListener('click', () => { this.muted = !this.muted; this.unlockAudio(); });
    this.root.querySelector('#playback-rate').addEventListener('change', event => {
      this.video.playbackRate = Number(event.target.value);
    });
    this.audioToggle?.addEventListener('click', () => this.setMix(this.requestedMix > 0 ? 0 : 1));
    this.video.addEventListener('play', () => {
      if (this.video.paused) return;
      this.intentPlaying = true;
      this.updateTransport();
    });
    this.video.addEventListener('playing', () => {
      if (this.video.paused) return;
      this.waiting = this.loadingSource = false;
      this.resumeAudio();
      if (!this.pending && !this.audioHold) this.message('');
      this.updateTransport();
    });
    this.video.addEventListener('pause', () => {
      if (!this.video.paused) return;
      if (!this.video.seeking && !this.audioHold && !this.loadingSource) this.intentPlaying = false;
      this.pauseAudio();
      this.updateTransport();
    });
    this.video.addEventListener('waiting', () => {
      this.waiting = true;
      this.pauseAudio();
      if (this.intentPlaying && !this.pending) this.message('Buffering…');
    });
    this.video.addEventListener('seeking', () => { this.pauseAudio(); this.sync(true); this.updateTransport(); });
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
      audio.addEventListener('error', () => {
        if (this.usingAudio && this.names().includes(name)) this.audioFailure(name);
      });
      audio.addEventListener('waiting', () => {
        if (!this.usingAudio || !this.names().includes(name) || !this.intentPlaying || this.video.seeking || this.video.paused) return;
        this.audioHold = performance.now();
        this.video.pause();
        this.pauseAudio();
        this.message('Buffering soundtrack…');
      });
      audio.addEventListener('canplay', () => this.resumeAfterAudioBuffer());
    }
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.sync(true); });
    document.addEventListener('keydown', event => this.keydown(event));
  }

  open(entry, url, autoplay = true) {
    this.openFocus = document.activeElement;
    this.pause();
    this.entry = entry;
    this.lyrics?.open(entry);
    this.originalUrl = url;
    this.failed = new Set();
    this.descriptors = entry.audio || {};
    this.mix = this.requestedMix = entry.defaultAudio === 'original' || !this.descriptors.karaoke ? 1 : 0;
    this.stream?.configure(entry, url);
    this.video.poster = entry.poster || '';
    // Unlock in the song-link gesture, before asynchronous HLS manifest loading.
    this.unlockAudio();
    this.setSource(this.stream?.supported ? 'auto' : 'original', 0, autoplay);
  }

  releaseAudio(name) {
    const audio = this.audio[name];
    this.trackAbort[name]?.abort();
    delete this.trackAbort[name];
    delete this.preparing[name];
    audio.pause();
    if (audio.getAttribute('src')) {
      audio.removeAttribute('src');
      audio.preload = 'none';
      audio.load();
    }
  }

  setSource(quality, position = 0, autoplay = true, embedded = false) {
    const generation = ++this.generation;
    this.playToken += 1;
    this.switchToken += 1;
    this.sourceAbort?.abort();
    this.sourceAbort = new AbortController();
    this.preparing = {};
    clearTimeout(this.releaseTimer);
    this.loadingSource = true;
    this.recovering = null;
    this.audioHold = null;
    this.waiting = this.pending = false;
    this.requestedMix = this.mix;
    this.intentPlaying = autoplay;
    this.video.pause();
    if (this.restorePosition) this.video.removeEventListener('loadedmetadata', this.restorePosition);
    this.restorePosition = null;
    Object.keys(this.audio).forEach(name => this.releaseAudio(name));
    this.usingStream = Boolean(this.stream?.supported && quality !== 'original');
    this.usingAudio = !embedded && this.names().every(name => this.descriptors[name] && !this.failed.has(name));
    // A video-only rendition has no embedded fallback soundtrack.
    if (!this.usingAudio) { quality = 'original'; this.usingStream = false; }
    this.video.controls = false;
    this.controls.hidden = false;
    this.root.querySelector('.soundtracks').hidden = !this.usingAudio ||
      !['original', 'karaoke'].every(name => this.descriptors[name]);
    this.message('');
    this.applyVolumes();
    this.updateButtons();
    this.updateTransport();
    if (this.usingAudio) this.names().forEach(name => this.ensureAudio(name));
    const started = this.stream?.start(quality, position, this.mix === 1 ? 'original' : 'karaoke', () => {
      if (generation !== this.generation) return;
      if (this.intentPlaying) this.play(); else this.loadingSource = false;
    }, () => {
      if (generation !== this.generation) return;
      this.setSource('original', this.video.currentTime || position, this.intentPlaying);
      this.message(this.entry.fallbackHeight ?
        'Adaptive video could not load. Using the compatibility video.' :
        'Adaptive video could not load. Using the original video.');
    });
    if (started) return;
    this.usingStream = false;
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
    if (this.descriptors[name] && !audio.getAttribute('src')) {
      audio.preload = 'auto';
      audio.src = this.descriptors[name];
      audio.load();
    }
    return audio;
  }

  startAudio(name) {
    const generation = this.generation, token = this.playToken;
    const audio = this.ensureAudio(name);
    this.syncAudio(audio, true);
    audio.play().catch(error => {
      if (generation !== this.generation || token !== this.playToken || !this.intentPlaying || !this.names().includes(name) || error.name === 'AbortError') return;
      if (error.name === 'NotAllowedError') { this.pause(); this.message('Press Play to enable sound.'); }
      else if (this.names().includes(name)) this.audioFailure(name);
    });
  }

  async play() {
    if (this.video.ended) this.seekTo(0);
    const generation = this.generation, token = ++this.playToken;
    this.intentPlaying = true;
    this.unlockAudio();
    this.updateTransport();
    if (this.usingAudio) this.names().forEach(name => this.startAudio(name));
    try {
      await this.video.play();
      if (generation !== this.generation || token !== this.playToken) return;
      this.sync(true);
      this.applyVolumes();
    } catch (error) {
      if (generation !== this.generation || token !== this.playToken || this.audioHold || error.name === 'AbortError') return;
      this.pause();
      this.message('Press Play to start playback.');
    }
  }

  pause() {
    this.playToken += 1;
    this.intentPlaying = this.loadingSource = false;
    this.audioHold = null;
    this.video.pause();
    this.pauseAudio();
    this.updateTransport();
  }

  togglePlay() { if (this.intentPlaying) this.pause(); else this.play(); }
  pauseAudio() { Object.values(this.audio).forEach(audio => audio.pause()); }

  resumeAudio() {
    if (!this.usingAudio || this.video.paused || this.video.seeking) return;
    this.names().forEach(name => this.startAudio(name));
    // A track may have started buffering before the video's playing event.
    // Do not rely on a second audio waiting event to hold the picture.
    if (this.names().some(name => !this.buffered(name))) {
      this.audioHold = performance.now();
      this.video.pause();
      this.pauseAudio();
      this.message('Buffering soundtrack…');
    }
  }

  buffered(name) {
    const audio = this.audio[name], time = this.video.currentTime;
    if (audio.error || audio.readyState < 2 || audio.seeking) return false;
    for (let i = 0; i < audio.buffered.length; i++) {
      if (audio.buffered.start(i) <= time + .03 && audio.buffered.end(i) >= Math.min(time + .5, audio.duration - .05)) return true;
    }
    return false;
  }

  resumeAfterAudioBuffer() {
    if (!this.audioHold || !this.usingAudio || !this.intentPlaying || this.video.seeking) return;
    const missing = this.names().filter(name => !this.buffered(name));
    if (!missing.length) { this.audioHold = null; this.play(); }
    else if (performance.now() - this.audioHold > 12000) this.audioFailure(missing[0]);
  }

  seekTo(time) {
    if (!Number.isFinite(this.video.duration)) return;
    if (this.audioHold) this.audioHold = performance.now();
    this.video.currentTime = Math.max(0, Math.min(time, this.video.duration));
    this.sync(true);
    this.updateTransport();
  }

  syncAudio(audio, force = false, clock = this.video, rate = this.video.playbackRate) {
    if (!audio.getAttribute('src') || audio.readyState < 1 || audio.error || audio.seeking) return;
    const target = Math.min(clock.currentTime, Math.max(0, audio.duration - .005));
    if (!Number.isFinite(target)) return;
    const difference = audio.currentTime - target;
    // Media clocks cannot provide sample-accurate stem alignment.
    const paired = clock !== this.video;
    if (force || Math.abs(difference) > (paired ? .045 : .12)) {
      if (Math.abs(difference) > (paired ? .012 : .025)) {
        try { audio.currentTime = target; } catch { /* Retry after metadata. */ }
      }
      audio.playbackRate = rate;
    } else {
      audio.playbackRate = rate * (Math.abs(difference) > (paired ? .008 : .025) ? 1 - Math.max(-.02, Math.min(.02, difference * .5)) : 1);
    }
  }

  sync(force = false) {
    if (this.root.hidden) return;
    this.stream?.updateStats();
    if (!this.usingAudio) return;
    if (!force && this.audioHold) {
      this.names().forEach(name => this.syncAudio(this.audio[name], true));
      this.resumeAfterAudioBuffer();
      return;
    }
    if (!force && (this.video.paused || this.video.seeking)) return;
    const names = this.names(), first = this.audio[names[0]];
    this.syncAudio(first, force);
    if (names.length > 1) this.syncAudio(this.audio[names[1]], force, first, first.playbackRate);
    if (this.pending) this.names(this.requestedMix).filter(name => !names.includes(name)).forEach(name => this.syncAudio(this.audio[name], force));
  }

  prepareTrack(name) {
    if (this.preparing[name]) return this.preparing[name];
    const audio = this.ensureAudio(name), signal = this.sourceAbort.signal;
    const controller = new AbortController();
    this.trackAbort[name] = controller;
    const generation = this.generation;
    const promise = new Promise((resolve, reject) => {
      const events = ['loadedmetadata', 'canplay', 'seeked', 'progress'];
      let settled = false, started = false, playingReady = false;
      const clean = () => {
        clearTimeout(timeout); clearInterval(poll);
        events.forEach(event => audio.removeEventListener(event, check));
        audio.removeEventListener('error', fail);
        signal.removeEventListener('abort', abort);
        controller.signal.removeEventListener('abort', abort);
      };
      const finish = error => {
        if (settled) return;
        settled = true;
        clean();
        if (error) { error.track = name; reject(error); } else resolve();
      };
      const abort = () => finish(new DOMException('Source changed', 'AbortError'));
      const fail = () => finish(new Error('Audio unavailable'));
      const check = () => {
        if (settled) return;
        if (generation !== this.generation || signal.aborted || controller.signal.aborted) { abort(); return; }
        if (audio.error) { fail(); return; }
        if (audio.readyState < 1 || audio.seeking) return;
        const target = Math.min(this.video.currentTime, Math.max(0, audio.duration - .005));
        const difference = Math.abs(audio.currentTime - target);
        if (difference > .035) { this.syncAudio(audio, true); return; }
        const shouldRun = this.intentPlaying && !this.video.paused && !this.waiting;
        if (!shouldRun) { audio.pause(); started = playingReady = false; }
        else if (audio.paused && !started) start();
        if (this.buffered(name) && (!shouldRun || playingReady)) finish();
      };
      const start = () => {
        started = true;
        audio.play().then(() => { playingReady = true; check(); }, error => {
          started = false;
          if (error.name === 'AbortError' && (!this.intentPlaying || this.waiting || this.audioHold)) check();
          else finish(error);
        });
      };
      const timeout = setTimeout(() => finish(new Error('Soundtrack timed out')), 12000);
      const poll = setInterval(check, 100);
      events.forEach(event => audio.addEventListener(event, check));
      audio.addEventListener('error', fail);
      signal.addEventListener('abort', abort, { once: true });
      controller.signal.addEventListener('abort', abort, { once: true });
      // Call play in the gesture; readiness still requires the correct seek and
      // buffered position, with one timeout covering the entire preparation.
      if (this.intentPlaying && !this.video.paused && !this.waiting) start();
      check();
    }).finally(() => {
      if (this.preparing[name] === promise) delete this.preparing[name];
      if (this.trackAbort[name] === controller) delete this.trackAbort[name];
    });
    this.preparing[name] = promise;
    return promise;
  }

  async setMix(value) {
    if (!this.usingAudio) return 'unavailable';
    value = Math.max(0, Math.min(1, value));
    if (!this.names(value).every(name => this.descriptors[name] && !this.failed.has(name))) return 'unavailable';
    this.unlockAudio();
    const token = ++this.switchToken, generation = this.generation;
    this.requestedMix = value;
    this.pending = value !== this.mix;
    this.updateButtons();
    clearTimeout(this.releaseTimer);
    if (!this.pending) { this.releaseUnused(); this.resumeAfterAudioBuffer(); this.message(''); return 'committed'; }
    const newNames = this.names(value).filter(name => !this.names().includes(name));
    if (newNames.length) this.message('Preparing vocal mix…');
    try {
      await Promise.all(newNames.map(name => this.prepareTrack(name)));
      if (token !== this.switchToken || generation !== this.generation) return 'superseded';
      this.mix = this.requestedMix = value;
      this.pending = false;
      if (newNames.length) this.sync(true);
      this.applyVolumes();
      this.updateButtons();
      this.message('');
      if (this.intentPlaying && !this.video.paused && !this.waiting) {
        if (newNames.length) this.resumeAudio();
      } else this.pauseAudio();
      this.releaseTimer = setTimeout(() => this.releaseUnused(), 160);
      this.resumeAfterAudioBuffer();
      return 'committed';
    } catch (error) {
      if (token !== this.switchToken || generation !== this.generation) return 'superseded';
      this.pending = false;
      this.requestedMix = this.mix;
      if (error.name !== 'AbortError' && error.name !== 'NotAllowedError' && error.track) this.failed.add(error.track);
      this.releaseUnused();
      this.updateButtons();
      this.message(error.name === 'NotAllowedError' ? 'Press Play, then adjust vocals again.' : 'That soundtrack could not load. Your current mix is unchanged.');
      return 'unavailable';
    }
  }

  releaseUnused() {
    const keep = new Set([...this.names(), ...(this.pending ? this.names(this.requestedMix) : [])]);
    for (const name of Object.keys(this.audio)) if (!keep.has(name)) this.releaseAudio(name);
  }

  async audioFailure(name) {
    if (this.recovering || !this.usingAudio || !this.names().includes(name)) return;
    const generation = this.generation;
    const recovery = { generation };
    this.recovering = recovery;
    this.failed.add(name);
    const other = name === 'original' ? 'karaoke' : 'original';
    try {
      if (this.descriptors[other] && !this.failed.has(other)) {
        const result = await this.setMix(other === 'original' ? 1 : 0);
        if (generation !== this.generation || result === 'superseded') return;
        if (!this.names().includes(name)) {
          this.message(`${name === 'original' ? 'Original vocals' : 'Karaoke'} could not load. Using the available soundtrack.`);
          this.resumeAfterAudioBuffer();
          return;
        }
      }
      if (generation !== this.generation) return;
      this.setSource('original', this.video.currentTime || 0, this.intentPlaying, true);
      this.message('Separate soundtracks could not load. Using the video’s included audio.');
    } finally { if (this.recovering === recovery) this.recovering = null; }
  }

  applyVolumes() {
    this.video.muted = this.usingAudio || this.muted;
    this.video.volume = this.baseVolume;
    const master = this.usingAudio && !this.muted ? this.baseVolume : 0;
    for (const [name, audio] of Object.entries(this.audio)) {
      const target = master * (name === 'original' ? this.mix : 1 - this.mix);
      const gain = this.gains[name];
      if (gain) {
        audio.volume = 1;
        audio.muted = false;
        const now = this.context.currentTime;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setTargetAtTime(target, now, .015);
      } else {
        audio.volume = target;
        audio.muted = target === 0;
      }
    }
    this.muteButton.textContent = this.muted ? 'Unmute' : 'Mute';
    this.muteButton.setAttribute('aria-pressed', String(this.muted));
    this.volume.value = String(this.baseVolume);
  }

  updateButtons() {
    const percent = Math.round(this.requestedMix * 100);
    this.root.querySelector('.vocal-mix').hidden = !['original', 'karaoke'].every(name => this.descriptors[name]);
    const canMix = this.usingAudio && ['original', 'karaoke'].every(name => this.descriptors[name] && !this.failed.has(name) && (this.gains[name] || this.audio[name].volumeCanFade));
    if (this.mixControl) {
      this.mixControl.disabled = !canMix;
      this.mixControl.value = String(percent);
      this.mixControl.setAttribute('aria-valuetext', `${percent}% original vocals${this.pending ? ', preparing' : ''}`);
      this.mixControl.setAttribute('aria-busy', String(Boolean(this.pending)));
    }
    if (this.mixValue) this.mixValue.textContent = `${percent}%`;
    if (this.audioToggle) {
      const next = this.requestedMix > 0 ? 'karaoke' : 'original';
      const available = this.usingAudio && Boolean(this.descriptors[next]) && !this.failed.has(next);
      const currentLabel = this.mix === 0 ? 'Karaoke' : this.mix === 1 ? 'Original vocals' : `Original vocals ${Math.round(this.mix * 100)}%`;
      this.audioToggle.disabled = !available;
      this.audioToggle.dataset.currentAudio = this.mix === 0 ? 'karaoke' : this.mix === 1 ? 'original' : 'mix';
      this.audioToggle.dataset.nextAudio = next;
      this.audioToggle.setAttribute('aria-busy', String(Boolean(this.pending)));
      this.audioToggle.setAttribute('aria-label', `Switch to ${next === 'original' ? 'original vocals' : 'karaoke'}. Current mix: ${currentLabel}.`);
      this.audioToggle.querySelector('.audio-toggle-current').textContent = currentLabel;
      this.audioToggle.querySelector('.audio-toggle-action').textContent = this.pending ? 'Preparing mix…' : available ? `Switch to ${next === 'original' ? 'original vocals' : 'karaoke'}` : 'Soundtrack unavailable';
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

  keydown(event) {
    if (this.root.hidden || !this.root.contains(document.activeElement) || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if (event.code === 'Space' && document.activeElement === this.video) { event.preventDefault(); this.togglePlay(); }
    if (event.key.toLowerCase() === 'm') { event.preventDefault(); this.muted = !this.muted; this.unlockAudio(); }
    if (event.key === 'ArrowRight') { event.preventDefault(); this.seekTo(this.video.currentTime + 5); }
    if (event.key === 'ArrowLeft') { event.preventDefault(); this.seekTo(this.video.currentTime - 5); }
  }

  async close() {
    this.pause();
    const generation = ++this.generation;
    const fullscreenExit = this.fullscreen?.close();
    this.switchToken += 1;
    this.sourceAbort?.abort();
    clearTimeout(this.releaseTimer);
    this.stream?.stop();
    if (this.restorePosition) this.video.removeEventListener('loadedmetadata', this.restorePosition);
    this.restorePosition = null;
    this.entry = null;
    this.lyrics?.close();
    this.video.removeAttribute('src');
    this.video.load();
    Object.keys(this.audio).forEach(name => this.releaseAudio(name));
    this.root.hidden = true;
    await fullscreenExit;
    if (generation === this.generation && this.openFocus?.isConnected) this.openFocus.focus({ preventScroll: true });
  }
}
window.CinemaPlayer = CinemaPlayer;
