'use strict';

// One HLS player handles picture and a prepared vocal mix on every platform.
// External tracks are only a legacy-catalog path; avoid rebuffer/seek loops there.
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
    this.hardSeeks = new WeakMap();
    this.events = [];
    this.video.volume = .5;
    this.videoVolumeCanFade = Math.abs(this.video.volume - .5) < .01;
    this.video.volume = this.baseVolume;
    this.stream = window.AdaptiveStream ? new AdaptiveStream(this) : null;
    this.bind();
    this.lyrics = window.LyricPreview ? new LyricPreview(root, this.video) : null;
    window.initCinemaFullscreen?.(this);
    this.timer = setInterval(() => this.sync(), 100);
  }

  // Each MediaElementSource is created once and retained across songs. Gain
  // nodes support browsers where changing HTMLMediaElement.volume is ignored.
  unlockAudio() {
    // Prepared HLS mixes need no competing audio elements or AudioContext.
    if (this.stream?.integrated) { this.applyVolumes(); this.updateButtons(); return; }
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
    this.mixControl?.addEventListener('input', () => {
      const value = Number(this.mixControl.value) / 100;
      if (this.integratedAudio) {
        this.mixPreview = this.stream.integratedDescriptor(value).value / 100;
        this.updateButtons();
      } else this.setMix(value);
    });
    this.mixControl?.addEventListener('change', () => {
      if (this.integratedAudio) {
        const value = Number(this.mixControl.value) / 100;
        this.mixPreview = null;
        this.setMix(value);
      }
    });
    this.root.querySelector('#copy-playback-info')?.addEventListener('click', () => this.copyPlaybackInfo());
    for (const event of ['play', 'playing', 'pause', 'waiting', 'seeking', 'seeked', 'error']) {
      this.video.addEventListener(event, () => this.record(`video:${event}`));
    }
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
      if (this.pending && this.integratedAudio && !this.loadingSource) this.stream?.settleMix();
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
        if (!this.usingAudio || !this.names().includes(name)) return;
        this.record(`audio:${name}:waiting`);
        this.scheduleAudioHold();
      });
      for (const event of ['canplay', 'progress', 'seeked']) {
        audio.addEventListener(event, () => this.resumeAfterAudioBuffer());
      }
    }
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.sync(true); });
    document.addEventListener('keydown', event => this.keydown(event));
  }

  open(entry, url, autoplay = true) {
    this.openFocus = document.activeElement;
    this.pause();
    this.entry = entry;
    this.events = [];
    const diagnostics = this.root.querySelector('#playback-info');
    if (diagnostics) { diagnostics.hidden = true; diagnostics.value = ''; }
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
    clearTimeout(this.holdTimer);
    this.holdTimer = null;
    this.hardSeeks = new WeakMap();
    this.loadingSource = true;
    this.recovering = null;
    this.audioHold = null;
    this.waiting = this.pending = false;
    this.mixPreview = null;
    this.requestedMix = this.mix;
    this.intentPlaying = autoplay;
    this.video.pause();
    if (this.restorePosition) this.video.removeEventListener('loadedmetadata', this.restorePosition);
    this.restorePosition = null;
    Object.keys(this.audio).forEach(name => this.releaseAudio(name));
    this.usingStream = Boolean(this.stream?.supported && quality !== 'original');
    this.integratedAudio = Boolean(this.stream?.integrated && this.usingStream && !embedded);
    if (this.integratedAudio) this.mix = this.requestedMix = this.stream.integratedDescriptor(this.mix).value / 100;
    // Compatibility MP4 also stays on one audio/video clock.
    if (this.stream?.integrated && !this.integratedAudio) embedded = true;
    this.usingAudio = !embedded && !this.integratedAudio && this.names().every(name => this.descriptors[name] && !this.failed.has(name));
    // A video-only rendition has no embedded fallback soundtrack.
    if (!this.usingAudio && !this.integratedAudio) {
      quality = 'original'; this.usingStream = false;
      this.mix = this.requestedMix = this.entry.defaultAudio === 'original' ? 1 : 0;
    }
    this.video.controls = false;
    this.controls.hidden = false;
    this.root.querySelector('.soundtracks').hidden = !(this.usingAudio || this.integratedAudio) ||
      !['original', 'karaoke'].every(name => this.descriptors[name]);
    this.message('');
    this.applyVolumes();
    this.updateButtons();
    this.updateTransport();
    if (this.usingAudio) this.names().forEach(name => this.ensureAudio(name));
    const started = this.stream?.start(quality, position, this.mix === 1 ? 'original' : 'karaoke', () => {
      if (generation !== this.generation) return;
      // Native play starts in the original user gesture, not after metadata.
      if (this.intentPlaying && this.stream.mode !== 'native') this.play();
      else if (!this.intentPlaying) this.loadingSource = false;
    }, () => {
      if (generation !== this.generation) return;
      this.setSource('original', this.video.currentTime || position, this.intentPlaying);
      this.message(this.entry.fallbackHeight ?
        'Adaptive video could not load. Using the compatibility video.' :
        'Adaptive video could not load. Using the original video.');
    });
    this.record('source');
    if (started) {
      if (autoplay && this.stream.mode === 'native') this.play();
      return;
    }
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
    this.syncAudio(audio);
    if (!audio.paused) return;
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
      this.sync();
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
    clearTimeout(this.holdTimer);
    this.holdTimer = null;
    this.video.pause();
    this.pauseAudio();
    this.updateTransport();
  }

  togglePlay() { if (this.intentPlaying) this.pause(); else this.play(); }
  pauseAudio() { Object.values(this.audio).forEach(audio => audio.pause()); }

  resumeAudio() {
    if (!this.usingAudio || this.video.paused || this.video.seeking) return;
    this.names().forEach(name => this.startAudio(name));
    this.scheduleAudioHold();
  }

  scheduleAudioHold() {
    if (this.holdTimer || this.audioHold || !this.usingAudio || !this.intentPlaying || this.video.paused || this.video.seeking) return;
    // A programmatic seek can emit waiting even with buffered media. Give it
    // time to settle before deciding that the network needs to refill audio.
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      if (!this.usingAudio || !this.intentPlaying || this.video.paused || this.video.seeking) return;
      const missing = this.names().filter(name => !this.buffered(name));
      if (!missing.length) return;
      if (missing.some(name => this.audio[name].seeking || performance.now() - (this.hardSeeks.get(this.audio[name]) ?? -Infinity) < 600)) {
        this.scheduleAudioHold(); return;
      }
      this.audioHold = performance.now();
      this.record('audio:hold');
      this.video.pause();
      this.pauseAudio();
      this.message('Buffering soundtrack…');
    }, 300);
  }

  buffered(name, ahead = .5) {
    const audio = this.audio[name], time = this.video.currentTime;
    if (audio.error || audio.readyState < 2 || audio.seeking) return false;
    for (let i = 0; i < audio.buffered.length; i++) {
      if (audio.buffered.start(i) <= time + .03 && audio.buffered.end(i) >= Math.min(time + ahead, audio.duration - .05)) return true;
    }
    return false;
  }

  resumeAfterAudioBuffer() {
    if (!this.audioHold || !this.usingAudio || !this.intentPlaying || this.video.seeking) return;
    const missing = this.names().filter(name => !this.buffered(name, 2));
    if (!missing.length) { this.record('audio:resume'); this.audioHold = null; this.play(); }
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
    const now = performance.now();
    const mayCorrect = force || now - (this.hardSeeks.get(audio) ?? -Infinity) > 1000;
    if (mayCorrect && (force || Math.abs(difference) > (paired ? .08 : .25))) {
      if (Math.abs(difference) > (paired ? .02 : .05)) {
        try { audio.currentTime = target; this.hardSeeks.set(audio, now); } catch { /* Retry after metadata. */ }
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
      this.names().forEach(name => this.syncAudio(this.audio[name]));
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
    if (this.integratedAudio) {
      const selected = this.stream.integratedDescriptor(Math.max(0, Math.min(1, value)));
      this.requestedMix = selected.value / 100;
      if (this.mix === this.requestedMix && !this.pending) { this.updateButtons(); return 'committed'; }
      const token = ++this.switchToken, generation = this.generation;
      this.pending = true;
      this.updateButtons();
      this.record('mix:requested');
      try {
        await this.stream.switchMix(this.requestedMix);
        if (token !== this.switchToken || generation !== this.generation) return 'superseded';
        this.mix = this.requestedMix = selected.value / 100;
        this.pending = false;
        this.updateButtons();
        this.record('mix:committed');
        this.message('');
        return 'committed';
      } catch (error) {
        if (token !== this.switchToken || generation !== this.generation) return 'superseded';
        this.pending = false;
        this.requestedMix = this.mix;
        this.updateButtons();
        this.message('That vocal mix could not be selected. Playback continues with the current soundtrack.');
        return 'unavailable';
      }
    }
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
    this.volume.disabled = !this.usingAudio && !this.videoVolumeCanFade;
    this.volume.title = this.volume.disabled ? 'Use your device volume buttons' : 'Volume';
    this.volume.setAttribute('aria-label', this.volume.title);
  }

  updateButtons() {
    const percent = Math.round((this.mixPreview ?? this.requestedMix) * 100);
    this.root.querySelector('.vocal-mix').hidden = !['original', 'karaoke'].every(name => this.descriptors[name]);
    const canMix = this.integratedAudio ? this.stream.integratedMixes.length > 1 :
      this.usingAudio && ['original', 'karaoke'].every(name => this.descriptors[name] && !this.failed.has(name) && (this.gains[name] || this.audio[name].volumeCanFade));
    if (this.mixControl) {
      this.mixControl.disabled = !canMix;
      this.mixControl.step = this.integratedAudio ? String(this.stream.mixStep) : '1';
      this.mixControl.title = this.integratedAudio ? 'Original vocals · 20% steps; release to apply' : 'Original vocals';
      this.mixControl.value = String(percent);
      this.mixControl.setAttribute('aria-valuetext', `${percent}% original vocals${this.pending ? ', preparing' : ''}`);
      this.mixControl.setAttribute('aria-busy', String(Boolean(this.pending)));
    }
    if (this.mixValue) this.mixValue.textContent = `${percent}%`;
    if (this.audioToggle) {
      const next = this.requestedMix > 0 ? 'karaoke' : 'original';
      const available = (this.usingAudio || this.integratedAudio) && Boolean(this.descriptors[next]) && !this.failed.has(next);
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

  mediaState(media) {
    const time = media.currentTime || 0;
    let ahead = 0;
    for (let i = 0; i < media.buffered.length; i++) {
      if (media.buffered.start(i) <= time + .1 && media.buffered.end(i) > time) ahead = media.buffered.end(i) - time;
    }
    return { time: +time.toFixed(2), ahead: +ahead.toFixed(2), ready: media.readyState,
      paused: media.paused, seeking: media.seeking, muted: media.muted, error: media.error?.code || null };
  }

  record(event) {
    if (!this.entry) return;
    this.events.push({ event, at: Math.round(performance.now()), video: this.mediaState(this.video),
      ...(this.usingAudio ? { audio: Object.fromEntries(this.names().map(name => [name, this.mediaState(this.audio[name])])) } : {}) });
    if (this.events.length > 40) this.events.shift();
  }

  async copyPlaybackInfo() {
    this.record('report');
    const value = JSON.stringify({ version: 'unified-audio-v2', song: this.entry?.id,
      browser: navigator.userAgent, mode: this.stream?.mode, integratedAudio: Boolean(this.integratedAudio),
      quality: this.stream?.selected, vocals: Math.round(this.mix * 100),
      video: { ...this.mediaState(this.video), width: this.video.videoWidth, height: this.video.videoHeight,
        audioDecodedBytes: this.video.webkitAudioDecodedByteCount ?? null }, events: this.events }, null, 2);
    try {
      await navigator.clipboard.writeText(value);
      this.message('Playback info copied. You can paste it into your message.');
    } catch {
      const field = this.root.querySelector('#playback-info');
      if (field) { field.value = value; field.hidden = false; field.focus(); field.select(); }
      this.message('Select and copy the playback info below.');
    }
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
