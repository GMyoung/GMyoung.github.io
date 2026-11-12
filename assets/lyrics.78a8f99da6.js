'use strict';

// Clean videos use two alternating bottom KTV rows with word highlighting.
// Baked-caption videos keep their smaller upcoming-line preview.
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
    this.upcomingGroup = document.createElement('div');
    this.upcomingGroup.className = 'lyric-upcoming';
    if (this.overlay) {
      this.overlay.append(this.upcomingGroup);
      this.upcomingGroup.append(this.label, this.text);
    }
    this.lines = document.createElement('div');
    this.lines.className = 'karaoke-lines';
    this.lines.hidden = true;
    this.slots = [0, 1].map(index => {
      const element = document.createElement('div');
      element.className = 'karaoke-line';
      element.dataset.slot = String(index);
      element.dataset.state = 'empty';
      this.lines.append(element);
      return { element, cue: null, state: 'empty', words: [] };
    });
    this.overlay?.append(this.lines);
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
      this.startClock();
    });
    for (const name of ['timeupdate', 'seeking', 'seeked', 'loadedmetadata', 'playing', 'pause', 'ended', 'ratechange']) {
      video.addEventListener(name, () => {
        if (name === 'loadedmetadata') this.updateNativeTrack();
        this.render();
        this.startClock();
      });
    }
    video.addEventListener('webkitbeginfullscreen', () => {
      this.nativeFullscreen = true;
      this.updateNativeTrack();
      this.render();
      this.startClock();
    });
    video.addEventListener('webkitendfullscreen', () => {
      this.nativeFullscreen = false;
      this.updateNativeTrack();
      this.render();
      this.startClock();
    });
    document.addEventListener('visibilitychange', () => {
      this.render();
      this.startClock();
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
    this.japaneseLayout = entry.lyrics?.display === 'ja-en-romaji';
    this.overlay?.classList.toggle('external-captions', this.externalCaptions);
    this.overlay?.classList.toggle('ja-en-romaji', this.japaneseLayout);
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
      this.bilingual = this.japaneseLayout || entry.lyrics.language === 'ja-Latn';
      this.overlay.classList.toggle('bilingual', this.bilingual);
      if (!Array.isArray(data.cues)) throw new Error('Invalid lyrics');
      this.cues = data.cues.filter(cue => cue && Number.isFinite(cue.start) && Number.isFinite(cue.end) &&
        cue.start >= 0 && cue.end > cue.start && typeof cue.text === 'string' && cue.text.trim())
        .map(cue => ({ start: cue.start, end: cue.end, text: cue.text,
          backing: typeof cue.backing === 'string' ? cue.backing.trim() : '',
          japanese: typeof cue.japanese === 'string' ? cue.japanese.trim() : '',
          translation: typeof cue.translation === 'string' ? cue.translation.trim() : '',
          romaji: typeof cue.romaji === 'string' ? cue.romaji.trim() : '',
          words: this.readWords(cue), japaneseWords: this.readJapaneseWords(cue) }))
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
      this.startClock();
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

  readWords(cue) {
    const primary = this.japaneseLayout && typeof cue.romaji === 'string' ? cue.romaji.trim() :
      this.bilingual ? cue.text.split('\n')[0] : cue.text;
    const tokens = primary.match(/\S+/g) || [];
    if (!Array.isArray(cue.words) || cue.words.length !== tokens.length) return [];
    let previous = cue.start;
    const words = [];
    for (let index = 0; index < tokens.length; index++) {
      const word = cue.words[index];
      if (!word || typeof word !== 'object' || word.text !== tokens[index] || !Number.isFinite(word.start) || !Number.isFinite(word.end) ||
          word.start < previous - .001 || word.start < cue.start - .001 || word.end > cue.end + .001 || word.end <= word.start) return [];
      words.push({ text: tokens[index], start: word.start, end: word.end });
      previous = word.start;
    }
    return words;
  }

  readJapaneseWords(cue) {
    if (!this.japaneseLayout || typeof cue.japanese !== 'string' || !Array.isArray(cue.japaneseWords)) return [];
    const compact = text => text.replace(/\s+/g, '');
    let previous = cue.start;
    const words = [];
    for (const word of cue.japaneseWords) {
      if (!word || typeof word.text !== 'string' || !compact(word.text) || !Number.isFinite(word.start) ||
          !Number.isFinite(word.end) || word.start < previous - .001 || word.start < cue.start - .001 ||
          word.end > cue.end + .001 || word.end <= word.start) return [];
      words.push({ text: word.text, start: word.start, end: word.end });
      previous = word.start;
    }
    return compact(words.map(word => word.text).join('')) === compact(cue.japanese) ? words : [];
  }

  startClock() {
    const running = this.enabled && this.externalCaptions && this.cues.length && !document.hidden &&
      !this.nativeFullscreen && !this.video.paused && !this.video.ended;
    if (!running) { this.stopClock(); return; }
    if (this.frame != null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.render();
      this.startClock();
    });
  }

  stopClock() {
    if (this.frame != null) cancelAnimationFrame(this.frame);
    this.frame = null;
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
    this.overlay.hidden = !preview && !current;
    this.overlay.classList.toggle('has-current', Boolean(current));
    this.lines.hidden = !this.externalCaptions;
    if (this.externalCaptions) {
      this.currentText.hidden = true;
      this.upcomingGroup.hidden = true;
      const currentIndex = current ? this.indexAt(time) - 1 : -1;
      const nextIndex = preview ? this.indexAt(time) : -1;
      for (let index = 0; index < this.slots.length; index++) {
        const cue = currentIndex >= 0 && currentIndex % 2 === index ? current :
          nextIndex >= 0 && nextIndex % 2 === index ? preview.cue : null;
        const state = cue === current && cue ? 'current' : cue ? 'next' : 'empty';
        this.renderSlot(this.slots[index], cue, state, time);
      }
      return;
    }
    this.upcomingGroup.hidden = !preview;
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

  renderSlot(slot, cue, state, time) {
    if (slot.cue !== cue || slot.state !== state) {
      slot.cue = cue;
      slot.state = state;
      slot.element.dataset.state = state;
      slot.element.setAttribute('aria-label', state === 'current' ? 'Current lyric' : state === 'next' ? 'Upcoming lyric' : '');
      slot.words = cue ? this.renderCue(slot.element, cue, state === 'current') : [];
      if (!cue) slot.element.replaceChildren();
    }
    for (const word of slot.words) {
      const progress = Math.max(0, Math.min(1, (time - word.start) / (word.end - word.start)));
      const value = `${(progress * 100).toFixed(2)}%`;
      if (word.value === value) continue;
      word.element.style.setProperty('--word-progress', value);
      word.value = value;
    }
  }

  renderCue(container, cue, karaoke = false) {
    if (this.japaneseLayout && cue.japanese) return this.renderJapaneseCue(container, cue, karaoke);
    const primary = document.createElement('span');
    primary.className = 'lyric-primary';
    const parts = cue.text.split('\n');
    const primaryText = this.bilingual ? parts.shift() : cue.text;
    const words = [];
    if (karaoke && cue.words.length) {
      let index = 0;
      for (const token of primaryText.match(/\s+|\S+/g) || []) {
        if (/^\s+$/.test(token)) { primary.append(document.createTextNode(token)); continue; }
        const timing = cue.words[index++];
        const word = document.createElement('span');
        word.className = 'karaoke-word';
        word.append(document.createTextNode(token));
        const fill = document.createElement('span');
        fill.className = 'karaoke-fill';
        fill.textContent = token;
        fill.setAttribute('aria-hidden', 'true');
        word.append(fill);
        primary.append(word);
        words.push({ element: word, start: timing.start, end: timing.end, value: null });
      }
    } else primary.textContent = primaryText;
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
    return words;
  }

  renderTimedText(container, text, timings, karaoke) {
    if (!karaoke || !timings.length) { container.textContent = text; return []; }
    // Preserve the supplied text and its spacing, including Japanese tokens
    // without spaces. Invalid token segmentation falls back to plain text.
    let cursor = 0;
    const ranges = [];
    for (const timing of timings) {
      const start = text.indexOf(timing.text, cursor);
      if (start < 0) { container.textContent = text; return []; }
      ranges.push({ timing, start });
      cursor = start + timing.text.length;
    }
    cursor = 0;
    const words = [];
    for (const { timing, start } of ranges) {
      if (start > cursor) container.append(document.createTextNode(text.slice(cursor, start)));
      const word = document.createElement('span');
      word.className = 'karaoke-word';
      word.append(document.createTextNode(timing.text));
      const fill = document.createElement('span');
      fill.className = 'karaoke-fill';
      fill.textContent = timing.text;
      fill.setAttribute('aria-hidden', 'true');
      word.append(fill);
      container.append(word);
      words.push({ element: word, start: timing.start, end: timing.end, value: null });
      cursor = start + timing.text.length;
    }
    if (cursor < text.length) container.append(document.createTextNode(text.slice(cursor)));
    return words;
  }

  renderJapaneseCue(container, cue, karaoke) {
    const pair = document.createElement('div');
    pair.className = 'lyric-language-pair';
    const japaneseColumn = document.createElement('div');
    japaneseColumn.className = 'lyric-japanese-column';
    const japanese = document.createElement('span');
    japanese.className = 'lyric-japanese';
    japanese.lang = 'ja';
    const words = this.renderTimedText(japanese, cue.japanese, cue.japaneseWords, karaoke);
    japaneseColumn.append(japanese);
    const romajiText = cue.romaji || cue.text.split('\n')[0];
    if (karaoke && romajiText && romajiText !== cue.japanese) {
      const romaji = document.createElement('span');
      romaji.className = 'lyric-romaji';
      romaji.lang = 'ja-Latn';
      words.push(...this.renderTimedText(romaji, romajiText, cue.words, true));
      japaneseColumn.append(romaji);
    }
    pair.append(japaneseColumn);
    const translation = cue.translation || cue.text.split('\n').slice(1).join('\n');
    if (translation) {
      const english = document.createElement('span');
      english.className = 'lyric-english';
      english.lang = 'en';
      english.textContent = translation;
      pair.append(english);
    } else pair.classList.add('single-language');
    container.replaceChildren(pair);
    if (cue.backing) {
      const backing = document.createElement('span');
      backing.className = 'lyric-backing';
      backing.textContent = cue.backing;
      container.append(backing);
    }
    return words;
  }

  close() {
    this.stopClock();
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
    for (const slot of this.slots) {
      slot.cue = null;
      slot.state = 'empty';
      slot.words = [];
      slot.element.replaceChildren();
      slot.element.dataset.state = 'empty';
    }
    this.lines.hidden = true;
    this.upcomingGroup.hidden = true;
    this.showCurrent = false;
    this.externalCaptions = false;
    this.bilingual = false;
    this.japaneseLayout = false;
    this.overlay?.classList.remove('bilingual', 'has-current', 'external-captions', 'ja-en-romaji');
    this.root.classList.remove('external-lyrics');
    if (this.overlay) this.overlay.hidden = true;
    if (this.text) this.text.textContent = '';
    if (this.currentText) { this.currentText.textContent = ''; this.currentText.hidden = true; }
    this.updateButton();
  }
}

window.LyricPreview = LyricPreview;
