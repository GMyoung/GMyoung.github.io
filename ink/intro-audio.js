// Original procedural sound design. No recordings, remote audio or speech API.
// AudioContext is created/resumed only from start(), called by a real gesture.
// API reference: https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Best_practices
const clamp = value => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const FLOOR = .0001;

export class IntroAudio {
  constructor() {
    this.context = null;
    this.groups = new Set();
    this.epoch = 0;
    this.pressId = 0;
    this.held = false;
    this.revealed = false;
    this.lastOnset = -Infinity;
    this.bed = null;
    this.latest = { progress: 0, motion: 0, held: false };
  }

  initialize() {
    if (this.context && this.context.state !== 'closed') return this.context;
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return null;
    const context = new Context({ latencyHint: 'interactive' });
    this.context = context;
    this.master = context.createGain();
    this.master.gain.value = .58;
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -17;
    compressor.knee.value = 20;
    compressor.ratio.value = 3;
    compressor.attack.value = .008;
    compressor.release.value = .16;
    this.master.connect(compressor);
    compressor.connect(context.destination);

    const size = Math.ceil(context.sampleRate * 2);
    this.noise = context.createBuffer(1, size, context.sampleRate);
    const samples = this.noise.getChannelData(0);
    let brown = 0;
    for (let index = 0; index < size; index++) {
      const white = Math.random() * 2 - 1;
      brown = (brown + .035 * white) / 1.035;
      samples[index] = brown * 2.4 + white * .19;
    }
    const real = new Float32Array(48);
    const imaginary = new Float32Array(48);
    for (let harmonic = 1; harmonic < imaginary.length; harmonic++) {
      imaginary[harmonic] = (1 - .2 * Math.cos(harmonic * .7)) / Math.pow(harmonic, 1.16);
    }
    this.voiceWave = context.createPeriodicWave(real, imaginary);
    this.room = context.createBuffer(2, Math.ceil(context.sampleRate * .48), context.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const impulse = this.room.getChannelData(channel);
      for (let index = 0; index < impulse.length; index++) {
        const fraction = index / impulse.length;
        impulse[index] = (Math.random() * 2 - 1) * Math.pow(1 - fraction, 3.6);
      }
    }
    return context;
  }

  group() {
    const gain = this.context.createGain();
    gain.connect(this.master);
    const group = { gain, nodes: new Set([gain]), sources: new Set(), closing: false };
    this.groups.add(group);
    return group;
  }

  node(group, node) {
    group.nodes.add(node);
    return node;
  }

  source(group, source) {
    this.node(group, source);
    group.sources.add(source);
    source.onended = () => {
      group.sources.delete(source);
      if (!group.sources.size) this.disconnect(group);
    };
    return source;
  }

  disconnect(group) {
    for (const node of group.nodes) {
      try { node.disconnect(); } catch { /* Already disconnected by a stop. */ }
    }
    this.groups.delete(group);
    if (this.bed?.group === group) this.bed = null;
  }

  fadeGroup(group, duration = .18) {
    if (!group || group.closing) return;
    group.closing = true;
    const now = this.context.currentTime;
    group.gain.gain.cancelScheduledValues(now);
    group.gain.gain.setTargetAtTime(0, now, duration / 5);
    for (const source of group.sources) {
      try { source.stop(now + duration); } catch { /* Already ended. */ }
    }
  }

  start() {
    if (this.revealed || this.held) return;
    this.held = true;
    this.latest.held = true;
    const pressId = ++this.pressId;
    const epoch = this.epoch;
    try {
      const context = this.initialize();
      if (!context) return;
      // Always issue resume in the gesture, even if an earlier suspend is pending.
      const resumed = context.resume();
      Promise.resolve(resumed).then(() => {
        if (epoch !== this.epoch || pressId !== this.pressId || !this.held || document.hidden || context.state !== 'running') return;
        this.master.gain.cancelScheduledValues(context.currentTime);
        this.master.gain.setTargetAtTime(.58, context.currentTime, .018);
        this.makeBed();
        if (context.currentTime - this.lastOnset > .65) {
          this.lastOnset = context.currentTime;
          this.chord(false);
        }
        this.update(this.latest);
      }).catch(() => { /* A browser may keep audio blocked; visuals still work. */ });
    } catch { /* Audio is optional on unsupported devices. */ }
  }

  makeBed() {
    this.fadeGroup(this.bed?.group, .08);
    const context = this.context;
    const group = this.group();
    const noise = this.source(group, context.createBufferSource());
    noise.buffer = this.noise;
    noise.loop = true;
    const highpass = this.node(group, context.createBiquadFilter());
    highpass.type = 'highpass';
    highpass.frequency.value = 260;
    const airFilter = this.node(group, context.createBiquadFilter());
    airFilter.type = 'bandpass';
    airFilter.frequency.value = 700;
    airFilter.Q.value = .65;
    const airGain = this.node(group, context.createGain());
    airGain.gain.value = 0;
    noise.connect(highpass).connect(airFilter).connect(airGain).connect(group.gain);
    const tones = [1, 1.5].map((ratio, index) => {
      const oscillator = this.source(group, context.createOscillator());
      oscillator.type = 'sine';
      oscillator.frequency.value = 261.63 * ratio;
      const gain = this.node(group, context.createGain());
      gain.gain.value = 0;
      oscillator.connect(gain).connect(group.gain);
      oscillator.start();
      return { oscillator, gain, ratio, level: index ? .012 : .021 };
    });
    noise.start();
    this.bed = { group, airFilter, airGain, tones };
  }

  update(values = {}) {
    this.latest = { ...this.latest, ...values };
    if (!this.bed || !this.held || this.context?.state !== 'running') return;
    const now = this.context.currentTime;
    const progress = clamp(this.latest.progress);
    const moving = this.latest.held === false ? 0 : Math.sqrt(clamp(this.latest.motion ?? this.latest.activity));
    const bed = this.bed;
    bed.airFilter.frequency.setTargetAtTime(650 * Math.pow(11, progress), now, .12);
    bed.airGain.gain.setTargetAtTime(moving * (.2 + progress * .17), now, moving ? .09 : .045);
    for (const tone of bed.tones) {
      tone.oscillator.frequency.setTargetAtTime(261.63 * Math.pow(3, progress) * tone.ratio, now, .13);
      tone.gain.gain.setTargetAtTime(moving * tone.level * (.45 + progress * .55), now, .09);
    }
  }

  release() {
    this.held = false;
    this.latest.held = false;
    this.latest.motion = 0;
    this.pressId++;
    this.fadeGroup(this.bed?.group, .22);
    this.bed = null;
  }

  chord(complete) {
    const context = this.context;
    const now = context.currentTime + .012;
    const group = this.group();
    const notes = complete ? [130.81, 196, 261.63, 329.63, 587.33] : [130.81, 196, 329.63, 440, 587.33];
    notes.forEach((frequency, index) => {
      const oscillator = this.source(group, context.createOscillator());
      oscillator.type = index < 2 ? 'sine' : 'triangle';
      oscillator.frequency.value = frequency;
      oscillator.detune.value = index % 2 ? 2 : -2;
      const lowpass = this.node(group, context.createBiquadFilter());
      lowpass.type = 'lowpass';
      lowpass.frequency.value = complete ? 2600 : 1500;
      const envelope = this.node(group, context.createGain());
      const begin = now + index * (complete ? .025 : .035);
      const duration = complete ? 1.65 : 1.03;
      const peak = (complete ? .064 : .046) * (index < 2 ? 1 : .72);
      envelope.gain.setValueAtTime(FLOOR, begin);
      envelope.gain.exponentialRampToValueAtTime(peak, begin + .06);
      envelope.gain.exponentialRampToValueAtTime(peak * .4, begin + duration * .4);
      envelope.gain.exponentialRampToValueAtTime(FLOOR, begin + duration);
      oscillator.connect(lowpass).connect(envelope).connect(group.gain);
      oscillator.start(begin);
      oscillator.stop(begin + duration + .03);
    });
  }

  vowelVoice(frequency, delay, pan, character) {
    const context = this.context;
    const start = context.currentTime + delay;
    const group = this.group();
    const voice = this.source(group, context.createOscillator());
    voice.setPeriodicWave(this.voiceWave);
    voice.frequency.setValueAtTime(frequency * .86, start);
    voice.frequency.exponentialRampToValueAtTime(frequency * 1.018, start + .11);
    voice.frequency.exponentialRampToValueAtTime(frequency, start + .37);
    voice.frequency.exponentialRampToValueAtTime(frequency * .985, start + 1.06);
    voice.detune.value = character;
    const envelope = this.node(group, context.createGain());
    envelope.gain.setValueAtTime(FLOOR, start);
    envelope.gain.exponentialRampToValueAtTime(.43, start + .08);
    envelope.gain.exponentialRampToValueAtTime(.36, start + .38);
    envelope.gain.exponentialRampToValueAtTime(.17, start + .84);
    envelope.gain.exponentialRampToValueAtTime(FLOOR, start + 1.19);
    // The opening palatal glide moves into an open /eh/: an audible "y-eh"
    // articulation instead of treating the completion sound as a bell chord.
    const formants = [
      { from: 285, to: 650, tail: 540, q: 3, level: 1.12 },
      { from: 2450, to: 1760, tail: 1950, q: 4.4, level: .7 },
      { from: 3150, to: 2750, tail: 2850, q: 5, level: .36 },
    ];
    for (const formant of formants) {
      const filter = this.node(group, context.createBiquadFilter());
      filter.type = 'bandpass';
      filter.Q.value = formant.q;
      const color = character > 0 ? 1.09 : .97;
      filter.frequency.setValueAtTime(formant.from * color, start);
      filter.frequency.exponentialRampToValueAtTime(formant.to * color, start + .2);
      filter.frequency.exponentialRampToValueAtTime(formant.tail * color, start + .95);
      const gain = this.node(group, context.createGain());
      gain.gain.value = formant.level;
      voice.connect(filter).connect(gain).connect(envelope);
    }
    const vibrato = this.source(group, context.createOscillator());
    vibrato.frequency.value = character > 0 ? 5.3 : 4.7;
    const vibratoDepth = this.node(group, context.createGain());
    vibratoDepth.gain.setValueAtTime(0, start);
    vibratoDepth.gain.linearRampToValueAtTime(7, start + .36);
    vibrato.connect(vibratoDepth).connect(voice.detune);
    const air = this.source(group, context.createBufferSource());
    air.buffer = this.noise;
    air.loop = true;
    const breathFilter = this.node(group, context.createBiquadFilter());
    breathFilter.type = 'bandpass';
    breathFilter.frequency.value = 1900;
    breathFilter.Q.value = .8;
    const breath = this.node(group, context.createGain());
    breath.gain.value = .07;
    air.connect(breathFilter).connect(breath).connect(envelope);

    const position = this.node(group, typeof context.createStereoPanner === 'function' ? context.createStereoPanner() : context.createGain());
    if (position.pan) position.pan.value = pan;
    envelope.connect(position).connect(group.gain);
    const room = this.node(group, context.createConvolver());
    room.buffer = this.room;
    const roomLevel = this.node(group, context.createGain());
    roomLevel.gain.value = .18;
    envelope.connect(room).connect(roomLevel).connect(group.gain);
    voice.start(start);
    vibrato.start(start);
    air.start(start);
    // Silent source tails keep the short room decay connected until it ends.
    voice.stop(start + 1.7);
    vibrato.stop(start + 1.7);
    air.stop(start + 1.7);
  }

  reveal() {
    if (this.revealed) return;
    this.revealed = true;
    this.release();
    if (!this.context || this.context.state !== 'running' || document.hidden) return;
    try {
      this.chord(true);
      this.vowelVoice(261.63, .035, -.2, -4);
      this.vowelVoice(329.63, .075, .2, 4);
    } catch { /* Missing audio features must not interrupt the reveal. */ }
  }

  stop() {
    this.epoch++;
    this.pressId++;
    this.held = false;
    this.revealed = false;
    this.latest = { progress: 0, motion: 0, held: false };
    if (!this.context || this.context.state === 'closed') return;
    const now = this.context.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(0, now);
    for (const group of [...this.groups]) {
      for (const source of group.sources) {
        try { source.stop(now); } catch { /* Already ended. */ }
      }
      this.disconnect(group);
    }
    this.bed = null;
    this.context.suspend().catch(() => {});
  }

  reset() { this.stop(); }
  suspend() { this.stop(); }
}
