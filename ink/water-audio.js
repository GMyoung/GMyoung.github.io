// Procedural water: a soft stream bed, fine ripples and quiet bubbling.
// The buffers are synthesized locally; there are no recordings or requests.
const modes = {
  heavy: { body: .25, spray: .095, bubbles: .12, cutoff: 2350 },
  light: { body: .073, spray: .019, bubbles: .038, cutoff: 1300 },
  still: { body: 0, spray: 0, bubbles: 0, cutoff: 900 },
};

export class WaterAudio {
  constructor() {
    this.context = null;
    this.mode = 'heavy';
    this.active = false;
    this.epoch = 0;
    this.stream = null;
  }

  initialize() {
    if (this.context && this.context.state !== 'closed') return this.context;
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return null;
    const context = new Context({ latencyHint: 'interactive' });
    this.context = context;
    this.master = context.createGain();
    this.master.gain.value = .46;
    this.master.connect(context.destination);
    const length = Math.ceil(context.sampleRate * 7);
    this.waterBuffer = context.createBuffer(2, length, context.sampleRate);
    this.bubbleBuffer = context.createBuffer(2, length, context.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const water = this.waterBuffer.getChannelData(channel);
      const bubbles = this.bubbleBuffer.getChannelData(channel);
      let low = 0;
      let mid = 0;
      for (let index = 0; index < length; index++) {
        const white = Math.random() * 2 - 1;
        low = .992 * low + .008 * white;
        mid = .91 * mid + .09 * white;
        const time = index / context.sampleRate;
        const swell = .79 + .12 * Math.sin(time * 1.795 + channel) + .08 * Math.sin(time * 4.488 + channel * 2);
        water[index] = (low * 3.7 + mid * .85 + white * .06) * swell;
      }
      // Short, descending resonances suggest small air pockets, not droplets
      // in a silent room. They repeat over a different rate from the stream.
      for (let time = .08; time < 6.8; time += .10 + Math.random() * .19) {
        const start = Math.floor(time * context.sampleRate);
        const duration = .055 + Math.random() * .075;
        const frequency = 330 + Math.random() * 1100;
        const strength = .11 + Math.random() * .13;
        const count = Math.floor(duration * context.sampleRate);
        let phase = 0;
        for (let index = 0; index < count && start + index < length; index++) {
          const age = index / context.sampleRate;
          phase += Math.PI * 2 * frequency * (1 - .3 * index / count) / context.sampleRate;
          const envelope = (1 - Math.exp(-age * 550)) * Math.exp(-age * 46);
          bubbles[start + index] += Math.sin(phase) * strength * envelope;
        }
      }
      // Short zero-ended windows remove a low-frequency jump at the loop seam.
      // The two stream rates keep their tiny soft gaps from aligning later.
      const seam = Math.floor(context.sampleRate * .018);
      for (let index = 0; index < seam; index++) {
        const weight = Math.sin(index / seam * Math.PI * .5);
        water[index] *= weight;
        water[length - index - 1] *= weight;
      }
    }
    return context;
  }

  makeStream() {
    if (this.stream) return;
    const context = this.context;
    const nodes = [];
    const sources = [];
    const track = node => { nodes.push(node); return node; };
    const source = (buffer, rate) => {
      const node = track(context.createBufferSource());
      node.buffer = buffer;
      node.loop = true;
      node.playbackRate.value = rate;
      sources.push(node);
      return node;
    };
    const body = track(context.createGain());
    const spray = track(context.createGain());
    const bubbles = track(context.createGain());
    body.gain.value = spray.gain.value = bubbles.gain.value = 0;
    const bodyFilter = track(context.createBiquadFilter());
    bodyFilter.type = 'lowpass';
    bodyFilter.frequency.value = 2350;
    bodyFilter.Q.value = .55;
    const rumbleFilter = track(context.createBiquadFilter());
    rumbleFilter.type = 'highpass';
    rumbleFilter.frequency.value = 105;
    const rippleFilter = track(context.createBiquadFilter());
    rippleFilter.type = 'bandpass';
    rippleFilter.frequency.value = 1800;
    rippleFilter.Q.value = .65;
    source(this.waterBuffer, .91).connect(rumbleFilter).connect(bodyFilter).connect(body).connect(this.master);
    source(this.waterBuffer, 1.13).connect(rippleFilter).connect(spray).connect(this.master);
    source(this.bubbleBuffer, .87).connect(bubbles).connect(this.master);
    this.stream = { nodes, sources, body, spray, bubbles, bodyFilter };
    for (const node of sources) node.start();
  }

  start(mode = this.mode) {
    this.mode = Object.hasOwn(modes, mode) ? mode : 'heavy';
    this.active = true;
    const epoch = this.epoch;
    try {
      const context = this.initialize();
      if (!context) return;
      // Call resume directly in the user's event, not in a later animation.
      const resumed = context.resume();
      Promise.resolve(resumed).then(() => {
        if (epoch !== this.epoch || !this.active || document.hidden || context.state !== 'running') return;
        this.master.gain.cancelScheduledValues(context.currentTime);
        this.master.gain.setTargetAtTime(.46, context.currentTime, .06);
        this.makeStream();
        this.setMode(this.mode);
      }).catch(() => { /* A blocked sound must never block drawing. */ });
    } catch { /* Unsupported devices remain fully usable without sound. */ }
  }

  setMode(mode) {
    this.mode = Object.hasOwn(modes, mode) ? mode : 'heavy';
    if (!this.stream || !this.context || this.context.state !== 'running') return;
    const now = this.context.currentTime;
    const settings = modes[this.mode];
    for (const layer of ['body', 'spray', 'bubbles']) {
      const parameter = this.stream[layer].gain;
      parameter.cancelScheduledValues(now);
      parameter.setTargetAtTime(settings[layer], now, .16);
    }
    this.stream.bodyFilter.frequency.setTargetAtTime(settings.cutoff, now, .23);
  }

  stop() {
    this.active = false;
    this.epoch++;
    if (!this.context || this.context.state === 'closed') return;
    const now = this.context.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(0, now);
    if (this.stream) {
      for (const source of this.stream.sources) {
        try { source.stop(now); } catch { /* Already stopped. */ }
      }
      for (const node of this.stream.nodes) {
        try { node.disconnect(); } catch { /* Already disconnected. */ }
      }
      this.stream = null;
    }
    this.context.suspend().catch(() => {});
  }
}
