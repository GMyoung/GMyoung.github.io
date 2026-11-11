'use strict';

// Preview the next line above the picture. Entries without baked lyrics can
// also show the current line, using the same clock through quality swaps.
class LyricPreview {
  constructor(root, video) {
    this.root = root;
    this.video = video;
    this.overlay = root.querySelector('#lyric-preview');
    this.label = root.querySelector('.lyric-preview-label');
    this.text = root.querySelector('.lyric-preview-text');
    this.currentText = root.querySelector('.lyric-current');
    if (this.overlay && !this.currentText) {
      this.currentText = document.createElement('span');
      this.currentText.className = 'lyric-current';
      this.currentText.hidden = true;
      this.overlay.prepend(this.currentText);
    }
    this.button = root.querySelector('#lyrics-toggle');
    this.enabled = true;
    this.cues = [];
    this.generation = 0;
    this.nativeFullscreen = false;
    this.button?.addEventListener('click', () => {
      this.enabled = !this.enabled;
      this.updateButton();
      this.updateNativeTrack();
      this.render();
    });
    for (const name of ['timeupdate', 'seeking', 'seeked', 'loadedmetadata', 'playing', 'ended']) {
      video.addEventListener(name, () => {
        if (name === 'loadedmetadata') this.updateNativeTrack();
        this.render();
      });
    }
    video.addEventListener('webkitbeginfullscreen', () => {
      this.nativeFullscreen = true;
      this.updateNativeTrack();
      this.render();
    });
    video.addEventListener('webkitendfullscreen', () => {
      this.nativeFullscreen = false;
      this.updateNativeTrack();
      this.render();
    });
    this.updateButton();
  }

  assetUrl(value) {
    if (!value) return null;
    try {
      const url = new URL(value, document.baseURI);
      return /^https?:$/.test(url.protocol) && url.origin === location.origin ? url.href : null;
    } catch { return null; }
  }

  async open(entry) {
    this.close();
    this.showCurrent = entry.lyrics?.showCurrent === true;
    this.externalCaptions = entry.lyrics?.placement === 'bottom';
    this.overlay?.classList.toggle('external-captions', this.externalCaptions);
    this.root.classList.toggle('external-lyrics', this.externalCaptions);
    const generation = this.generation;
    const url = this.assetUrl(entry.lyrics?.url);
    if (!url || !this.overlay) return;
    this.controller = new AbortController();
    try {
      const response = await fetch(url, { signal: this.controller.signal, credentials: 'same-origin' });
      if (!response.ok) throw new Error('Lyrics unavailable');
      const data = await response.json();
      if (generation !== this.generation) return;
      this.bilingual = entry.lyrics.language === 'ja-Latn';
      this.overlay.classList.toggle('bilingual', this.bilingual);
      if (!Array.isArray(data.cues)) throw new Error('Invalid lyrics');
      this.cues = data.cues.filter(cue => Number.isFinite(cue.start) && Number.isFinite(cue.end) &&
        cue.start >= 0 && cue.end > cue.start && typeof cue.text === 'string' && cue.text.trim())
        .map(cue => ({ start: cue.start, end: cue.end, text: cue.text,
          backing: typeof cue.backing === 'string' ? cue.backing.trim() : '' }))
        .sort((a, b) => a.start - b.start);
      const vtt = this.assetUrl(entry.lyrics.vtt);
      if (vtt && this.cues.length) {
        this.track = document.createElement('track');
        this.track.kind = 'subtitles';
        this.track.label = this.externalCaptions ? 'Lyrics' : 'Next lyric';
        this.track.srclang = entry.lyrics.language || 'en';
        this.track.src = vtt;
        this.track.addEventListener('load', () => this.updateNativeTrack());
        this.video.append(this.track);
      }
      this.updateButton();
      this.updateNativeTrack();
      this.render();
    } catch (error) {
      if (generation !== this.generation || error.name === 'AbortError') return;
      this.cues = [];
      this.updateButton();
      this.render();
      // A missing optional lyric file must never interrupt music playback.
    }
  }

  updateButton() {
    if (!this.button) return;
    this.button.hidden = !this.cues.length;
    this.button.setAttribute('aria-pressed', String(this.enabled));
    const singleOverlay = this.externalCaptions;
    this.button.textContent = `${singleOverlay ? 'Lyrics' : 'Next lyric'}: ${this.enabled ? 'on' : 'off'}`;
    this.button.setAttribute('aria-label', singleOverlay ? (this.enabled ? 'Hide lyrics' : 'Show lyrics') :
      (this.enabled ? 'Hide the next lyric preview' : 'Show the next lyric preview'));
  }

  updateNativeTrack() {
    if (this.track?.track) this.track.track.mode = this.nativeFullscreen && this.enabled ? 'showing' : 'disabled';
  }

  indexAt(time) {
    // Find the most recently started cue; intervals are [start, end).
    let low = 0, high = this.cues.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.cues[mid].start <= time) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  upcoming(time) {
    const low = this.indexAt(time);
    const current = this.cues[low - 1];
    const next = this.cues[low];
    if (!next) return null;
    if (current && time < current.end && next.start - current.end <= 8) {
      return { cue: next, countdown: false };
    }
    if (next.start - time <= 5) return { cue: next, countdown: true };
    return null;
  }

  render() {
    if (!this.overlay) return;
    const time = this.video.currentTime || 0;
    const visible = this.enabled && !this.nativeFullscreen && !this.video.ended;
    let preview = visible ? this.upcoming(time) : null;
    const candidate = this.cues[this.indexAt(time) - 1];
    const current = visible && this.showCurrent && candidate && time < candidate.end ? candidate : null;
    if (this.externalCaptions && current && preview && current.text === preview.cue.text && current.backing === preview.cue.backing) preview = null;
    this.overlay.hidden = !preview && !current;
    this.overlay.classList.toggle('has-current', Boolean(current));
    this.currentText.hidden = !current;
    if (current && this.bilingual && this.renderedCurrent !== current) {
      this.renderCue(this.currentText, current);
      this.renderedCurrent = current;
    } else if (current && !this.bilingual && this.currentText.textContent !== current.text) this.currentText.textContent = current.text;
    this.label.hidden = !preview;
    this.text.hidden = !preview;
    if (!preview) return;
    const label = preview.countdown ? `Next · starts in ${Math.max(1, Math.ceil(preview.cue.start - this.video.currentTime))}s` : 'Next';
    if (this.label.textContent !== label) this.label.textContent = label;
    if (this.renderedPreview !== preview.cue) {
      this.renderCue(this.text, preview.cue);
      this.renderedPreview = preview.cue;
    }
  }

  renderCue(container, cue) {
    const primary = document.createElement('span');
    primary.className = 'lyric-primary';
    const parts = cue.text.split('\n');
    primary.textContent = this.bilingual ? parts.shift() : cue.text;
    container.replaceChildren(primary);
    // Keep a simultaneous backing response attached to its own lead line.
    if (cue.backing) {
      const backing = document.createElement('span');
      backing.className = 'lyric-backing';
      backing.textContent = cue.backing;
      container.append(backing);
    }
    if (this.bilingual && parts.length) {
      const translation = document.createElement('span');
      translation.className = 'lyric-translation';
      translation.textContent = parts.join('\n');
      container.append(translation);
    }
  }

  close() {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
    if (this.track) {
      if (this.track.track) this.track.track.mode = 'disabled';
      this.track.remove();
      this.track = null;
    }
    this.cues = [];
    this.renderedPreview = null;
    this.renderedCurrent = null;
    this.showCurrent = false;
    this.externalCaptions = false;
    this.bilingual = false;
    this.overlay?.classList.remove('bilingual', 'has-current', 'external-captions');
    this.root.classList.remove('external-lyrics');
    if (this.overlay) this.overlay.hidden = true;
    if (this.text) this.text.textContent = '';
    if (this.currentText) { this.currentText.textContent = ''; this.currentText.hidden = true; }
    this.updateButton();
  }
}

window.LyricPreview = LyricPreview;
