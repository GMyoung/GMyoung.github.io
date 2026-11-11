'use strict';

// One MediaSource clock owns both picture and the selected HLS soundtrack.
// Throughput is observed from normal fragment downloads; no speed test runs on open.
class AdaptiveStream {
  constructor(player) {
    this.player = player;
    this.video = player.video;
    this.quality = player.root.querySelector('#video-quality');
    this.stats = player.root.querySelector('#stream-stats');
    this.check = player.root.querySelector('#connection-check');
    this.serial = 0;
    this.mode = 'mp4';
    this.selected = 'original';
    this.quality?.addEventListener('change', () => player.changeQuality(this.quality.value));
    this.check?.addEventListener('click', () => this.checkConnection());
    this.video.addEventListener('timeupdate', () => this.updateStats());
    this.video.addEventListener('progress', () => this.updateStats());
  }

  safeUrl(value) {
    if (typeof value !== 'string' || !value) return null;
    try {
      const url = new URL(value, location.href);
      return url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) ? url.href : null;
    } catch { return null; }
  }

  configure(entry, originalUrl) {
    this.stop();
    this.originalUrl = this.safeUrl(originalUrl);
    this.defaultAudio = entry.defaultAudio || 'karaoke';
    this.sourceHeight = Number(entry.sourceHeight) || null;
    const url = this.safeUrl(entry.streaming?.url);
    const variants = (entry.streaming?.variants || []).map(item => ({
      height: Number(item.height), url: this.safeUrl(item.url)
    })).filter(item => item.url && Number.isFinite(item.height) && item.height > 0);
    this.descriptor = url && variants.length ? { url, variants } : null;
    this.supported = Boolean(this.descriptor &&
      (window.Hls?.isSupported() || this.video.canPlayType('application/vnd.apple.mpegurl')));
    if (this.quality) {
      this.quality.replaceChildren();
      if (this.supported) {
        this.addOption('auto', 'Auto');
        variants.forEach(item => this.addOption(String(item.height), `${item.height}p`));
      }
      this.addOption('original', `Original${this.sourceHeight ? ` · ${this.sourceHeight}p` : ''}`);
      this.quality.disabled = !this.supported;
    }
    this.probeMbps = null;
    this.probeMessage = '';
    if (this.check) this.check.disabled = !this.originalUrl;
  }

  addOption(value, label) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    this.quality.append(option);
  }

  start(quality, position, track, ready, failed) {
    this.stop();
    this.selected = this.supported && quality !== 'original' ? quality : 'original';
    if (this.quality) this.quality.value = this.selected;
    this.mode = 'mp4';
    this.updateStats();
    if (this.selected === 'original') return false;
    const serial = this.serial;
    const current = () => serial === this.serial;
    this.track = track;
    this.mbps = null;
    this.height = null;
    this.recoveries = { network: 0, media: 0 };
    let delivered = false;
    const deliver = () => {
      if (!current() || delivered) return;
      delivered = true;
      ready();
    };
    const fail = () => { if (current()) failed(); };
    if (window.Hls?.isSupported()) {
      this.mode = 'hls';
      const Hls = window.Hls;
      const hls = this.hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        autoStartLoad: false,
        startLevel: 0,
        startPosition: position,
        maxBufferLength: 40,
        maxMaxBufferLength: 60,
        backBufferLength: 15,
        abrEwmaDefaultEstimate: 650000,
        abrBandWidthFactor: .7,
        abrBandWidthUpFactor: .55,
        audioPreference: { name: this.trackLabel(track) }
      });
      hls.on(Hls.Events.MEDIA_ATTACHED, () => { if (current()) hls.loadSource(this.descriptor.url); });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (!current()) return;
        this.applyHlsQuality();
        this.selectInitialAudio();
        hls.startLoad(position);
        deliver();
      });
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => { if (current()) this.selectInitialAudio(); });
      hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_, data) => {
        if (!current()) return;
        const name = this.trackName(hls.audioTracks[data.id]?.name);
        if (name) this.track = name;
        if (this.pendingTrack && name === this.pendingTrack.name) this.settleTrack();
      });
      hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
        if (!current()) return;
        this.height = hls.levels[data.level]?.height || null;
        this.updateStats();
      });
      hls.on(Hls.Events.FRAG_LOADED, (_, data) => {
        if (!current() || data.frag?.type !== 'main') return;
        const stats = data.stats || data.frag?.stats;
        const ms = stats?.loading?.end - stats?.loading?.start;
        if (ms > 0 && stats.loaded > 0) {
          const sample = stats.loaded * 8 / ms / 1000;
          this.mbps = this.mbps === null ? sample : this.mbps * .6 + sample * .4;
        }
        this.updateStats();
      });
      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        if (current()) clearTimeout(this.recoveryTimer);
      });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!current() || !data.fatal) return;
        // startLoad cannot fetch an initial manifest that never loaded.
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && !hls.levels.length) { fail(); return; }
        clearTimeout(this.recoveryTimer);
        this.recoveryTimer = setTimeout(fail, 15000);
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && this.recoveries.network++ < 1) {
          hls.startLoad(this.video.currentTime || position);
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && this.recoveries.media++ < 1) {
          hls.recoverMediaError();
        } else fail();
      });
      hls.attachMedia(this.video);
    } else {
      this.mode = 'native';
      // Native HLS has no portable level API. A manual choice uses a single-level
      // master and restores the time; its audio group is retained in every master.
      const variant = this.descriptor.variants.find(item => String(item.height) === this.selected);
      this.nativeReady = () => {
        if (!current()) return;
        if (position > 0 && Number.isFinite(this.video.duration)) this.video.currentTime = Math.min(position, this.video.duration);
        if (!this.selectNativeAudio(track) && track !== this.defaultAudio) { fail(); return; }
        deliver();
      };
      this.nativeError = fail;
      this.video.addEventListener('loadedmetadata', this.nativeReady, { once: true });
      this.video.addEventListener('error', this.nativeError);
      this.video.src = variant?.url || this.descriptor.url;
      this.video.load();
    }
    this.updateStats();
    return true;
  }

  applyHlsQuality() {
    if (!this.hls) return;
    const index = this.hls.levels.findIndex(level => String(level.height) === this.selected);
    this.hls.nextLevel = this.selected === 'auto' ? -1 : index;
  }

  changeInPlace(quality) {
    if (this.mode !== 'hls' || quality === 'original') return false;
    this.selected = quality;
    if (this.quality) this.quality.value = quality;
    this.applyHlsQuality();
    this.updateStats();
    return true;
  }

  trackLabel(name) { return name === 'original' ? 'Original vocals' : 'Karaoke'; }
  trackName(label) {
    if (/original/i.test(label || '')) return 'original';
    if (/karaoke/i.test(label || '')) return 'karaoke';
    return null;
  }

  selectInitialAudio() {
    if (!this.hls || this.pendingTrack) return;
    const index = this.hls.audioTracks.findIndex(item => this.trackName(item.name) === this.track);
    if (index >= 0 && this.hls.audioTrack !== index) this.hls.audioTrack = index;
  }

  selectNativeAudio(name) {
    const tracks = this.video.audioTracks;
    if (!tracks?.length) return false;
    const target = [...Array(tracks.length)].map((_, i) => tracks[i]).find(item => this.trackName(item.label) === name);
    if (!target) return false;
    for (let i = 0; i < tracks.length; i++) tracks[i].enabled = tracks[i] === target;
    this.track = name;
    return true;
  }

  switchTrack(name) {
    if (this.mode === 'native') return this.selectNativeAudio(name) ? Promise.resolve() : Promise.reject(new Error('Native track control unavailable'));
    if (!this.hls) return Promise.reject(new Error('Stream is closed'));
    const index = this.hls.audioTracks.findIndex(item => this.trackName(item.name) === name);
    if (index < 0) return Promise.reject(new Error('Soundtrack unavailable'));
    if (this.hls.audioTrack === index) { this.track = name; return Promise.resolve(); }
    this.settleTrack(new DOMException('Replaced', 'AbortError'));
    return new Promise((resolve, reject) => {
      this.pendingTrack = { name, resolve, reject, timer: setTimeout(() => {
        // Restore the previous selection if the new track never became ready.
        const previous = this.hls?.audioTracks.findIndex(item => this.trackName(item.name) === this.track);
        if (previous >= 0) this.hls.audioTrack = previous;
        this.settleTrack(new Error('Soundtrack timed out'));
      }, 12000) };
      this.hls.audioTrack = index;
    });
  }

  settleTrack(error) {
    if (!this.pendingTrack) return;
    const pending = this.pendingTrack;
    this.pendingTrack = null;
    clearTimeout(pending.timer);
    if (error) pending.reject(error); else pending.resolve();
  }

  bufferAhead() {
    const time = this.video.currentTime;
    for (let i = 0; i < this.video.buffered.length; i++) {
      if (this.video.buffered.start(i) <= time + .1 && this.video.buffered.end(i) > time) return this.video.buffered.end(i) - time;
    }
    return 0;
  }

  updateStats() {
    if (!this.stats) return;
    const height = this.height || (this.mode === 'native' ? this.video.videoHeight : null);
    const label = this.selected === 'original' ? 'Original' : this.selected === 'auto' ? `Auto${height ? ` · ${height}p` : ''}` : `${this.selected}p`;
    const speed = this.mbps !== null && this.mbps !== undefined ? `${this.mbps.toFixed(1)} Mbps media` : this.probeMbps ? `${this.probeMbps.toFixed(1)} Mbps sample` : this.mode === 'hls' ? 'Measuring while playing' : 'Use Check connection for speed';
    const text = `${label} · ${this.probeMessage || speed} · ${Math.floor(this.bufferAhead())}s buffered`;
    if (this.stats.textContent !== text) this.stats.textContent = text;
  }

  async checkConnection() {
    if (!this.originalUrl || this.probe) return;
    const serial = this.serial;
    const controller = this.probe = new AbortController();
    const limit = 256 * 1024;
    const timeout = setTimeout(() => controller.abort(), 8000);
    if (this.check) this.check.disabled = true;
    this.probeMessage = 'Checking media connection…';
    this.updateStats();
    let reader;
    try {
      const url = new URL(this.originalUrl);
      url.searchParams.set('connection-check', String(Date.now()));
      const start = performance.now();
      const response = await fetch(url, { headers: { Range: `bytes=0-${limit - 1}` }, cache: 'no-store', signal: controller.signal });
      if (!response.ok || !response.body) throw new Error('Connection unavailable');
      reader = response.body.getReader();
      let bytes = 0;
      while (bytes < limit) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
      }
      await reader.cancel();
      if (serial !== this.serial) return;
      const elapsed = performance.now() - start;
      if (!bytes || elapsed <= 0) throw new Error('No media data received');
      this.probeMbps = bytes * 8 / elapsed / 1000;
      this.probeMessage = `${this.probeMbps.toFixed(1)} Mbps sample`;
    } catch {
      if (serial === this.serial) this.probeMessage = 'Connection check did not complete';
    } finally {
      clearTimeout(timeout);
      reader?.cancel().catch(() => {});
      if (this.probe === controller) this.probe = null;
      if (serial === this.serial) {
        if (this.check) this.check.disabled = false;
        this.updateStats();
      }
    }
  }

  stop() {
    this.serial += 1;
    clearTimeout(this.recoveryTimer);
    this.settleTrack(new DOMException('Source changed', 'AbortError'));
    this.probe?.abort();
    this.probe = null;
    this.probeMessage = '';
    if (this.check) this.check.disabled = !this.originalUrl;
    this.hls?.destroy();
    this.hls = null;
    if (this.nativeReady) this.video.removeEventListener('loadedmetadata', this.nativeReady);
    if (this.nativeError) this.video.removeEventListener('error', this.nativeError);
    this.nativeReady = null;
    this.nativeError = null;
    this.mbps = null;
    this.height = null;
  }
}
window.AdaptiveStream = AdaptiveStream;
