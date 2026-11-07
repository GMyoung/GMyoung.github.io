import { InkCurriculum, WORD_BANK } from './curriculum.js';
import { BrushStroke, createBrushDemo, paintBrushStamps } from './brush.js';

const brushSizes = { fine: 4.5, medium: 9, broad: 16 };
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

function resample(points, count) {
  if (points.length < 2) return null;
  const lengths = [0];
  for (let index = 1; index < points.length; index++) lengths.push(lengths[index - 1] + distance(points[index - 1], points[index]));
  const length = lengths[lengths.length - 1];
  if (length < .001) return null;
  const sampled = [];
  let segment = 1;
  for (let index = 0; index < count; index++) {
    const at = length * index / (count - 1);
    while (segment < points.length - 1 && lengths[segment] < at) segment++;
    const a = points[segment - 1];
    const b = points[segment];
    const ratio = (at - lengths[segment - 1]) / Math.max(.001, lengths[segment] - lengths[segment - 1]);
    sampled.push({ x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio });
  }
  return { points: sampled, length };
}

function scoreStroke(actual, reference) {
  const target = resample(reference, 48);
  const attempt = resample(actual, 48);
  if (!target || !attempt || !target.length || actual.length < 2 || attempt.length < target.length * .2) return 0;
  const tolerance = Math.max(12, target.length * .065);
  let nearestError = 0;
  let orderedError = 0;
  const positions = [];
  attempt.points.forEach((point, index) => {
    let best = Infinity;
    let position = 0;
    target.points.forEach((expected, candidate) => {
      const error = distance(point, expected);
      if (error < best) { best = error; position = candidate; }
    });
    nearestError += best;
    orderedError += distance(point, target.points[index]);
    positions.push(position);
  });
  const coverage = target.points.filter(point => attempt.points.some(candidate => distance(point, candidate) < tolerance)).length / 48;
  const shape = Math.exp(-nearestError / 48 / tolerance);
  const order = Math.exp(-orderedError / 48 / (tolerance * 1.7));
  const endpoints = Math.exp(-(distance(actual[0], reference[0]) + distance(actual[actual.length - 1], reference[reference.length - 1])) / (tolerance * 3));
  const lengthRatio = attempt.length / target.length;
  const lengthFit = Math.exp(-Math.abs(Math.log(lengthRatio)) * 1.4);
  let backtracking = 0;
  for (let index = 1; index < positions.length; index++) backtracking += Math.max(0, positions[index - 1] - positions[index]);
  const direction = clamp((positions[47] - positions[0]) / 38, 0, 1) * Math.exp(-backtracking / 24);
  return Math.round(100 * (.30 * shape + .30 * order + .25 * coverage + .15 * endpoints) * lengthFit * direction);
}

function widthProfile(points, count = 24) {
  if (points.length < 2) return null;
  const lengths = [0];
  for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1] + distance(points[i - 1], points[i]));
  const total = lengths[lengths.length - 1];
  if (total < 1) return null;
  let segment = 1;
  return Array.from({ length: count }, (_, index) => {
    const at = total * index / (count - 1);
    while (segment < points.length - 1 && lengths[segment] < at) segment++;
    const t = (at - lengths[segment - 1]) / Math.max(.001, lengths[segment] - lengths[segment - 1]);
    return points[segment - 1].width + (points[segment].width - points[segment - 1].width) * t;
  });
}

function brushMatch(actual, expected) {
  const a = widthProfile(actual);
  const b = widthProfile(expected);
  if (!a || !b) return 0;
  const error = a.reduce((sum, value, i) => sum + Math.abs(Math.log(Math.max(.2, value) / Math.max(.2, b[i]))), 0) / a.length;
  return Math.exp(-error);
}

export class InkWriter {
  constructor(options = {}) {
    this.options = options;
    this.paper = document.querySelector('#writing-paper');
    this.canvas = document.querySelector('#writing-strokes');
    this.guide = document.querySelector('#practice-guide');
    this.feedbackCanvas = document.querySelector('#practice-feedback');
    this.status = document.querySelector('#writing-status');
    this.wash = document.querySelector('#wash-overlay');
    this.printSheet = document.querySelector('#print-sheet');
    this.namePicker = document.querySelector('#name-picker');
    this.brush = 'medium';
    this.practice = false;
    this.lessonMode = 'free';
    this.reducedMotion = Boolean(options.reducedMotion);
    this.active = false;
    this.busy = false;
    this.pointer = null;
    this.frame = 0;
    this.clock = 0;
    this.target = null;
    this.feedback = null;
    this.curriculum = new InkCurriculum();
    this.characters = [];
    this.demoCache = new Map();
    this.demoInput = 'mouse';
    this.committedWriting = [];
    this.lessonsReady = false;
    this.namesReady = false;
    this.width = 1;
    this.height = 1;
    this.practiceArea = { x: 0, y: 0, size: 1, top: 0 };
    this.tick = this.tick.bind(this);
    this.resize();
    this.bindEvents();
    this.updateLessonControls();
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(this.paper);
    this.loadLessons();
  }

  async loadLessons() {
    const foundationLoading = this.loadFoundationModels();
    try {
      const definitions = [
        { name: '艾', file: 'ai', types: ['横', '竖', '竖', '撇', '捺'] },
        { name: '达', file: 'da', types: ['横', '撇', '捺', '点', '横折折撇', '捺'] },
        { name: '伊', file: 'name-yi', types: ['撇', '竖', '横折', '横', '横', '撇'] },
        { name: '莱', file: 'name-lai', types: ['横', '竖', '竖', '横', '点', '撇', '横', '竖', '撇', '捺'] },
      ];
      this.characters = await Promise.all(definitions.map(async definition => {
        const response = await fetch(new URL(`./data/${definition.file}.json`, import.meta.url));
        if (!response.ok) throw new Error(`Character data unavailable: ${definition.file}`);
        const data = await response.json();
        if (data.strokes?.length !== definition.types.length || data.medians?.length !== data.strokes.length) throw new Error('Invalid character data');
        return { ...data, name: definition.name, types: definition.types };
      }));
      if (!this.curriculum.setCharacters(this.characters)) throw new Error('Invalid lesson geometry');
      this.namesReady = true;
    } catch (error) {
      this.curriculum.fallBackToFoundation();
      console.error('Character lessons unavailable; continuing basic strokes', error);
    }
    await foundationLoading;
    this.lessonsReady = true;
    this.renderNamePreviews();
    this.updateLessonControls();
    if (!this.namePicker.hidden) this.status.textContent = this.namesReady ? '选择要学习的名字，艾达或伊莱。' : '名字笔画暂时无法加载，请重新进入页面。';
    if (this.practice) this.nextTarget();
  }

  async loadFoundationModels() {
    try {
      const response = await fetch(new URL('./data/foundation-models.json', import.meta.url));
      if (!response.ok) throw new Error('Stroke models unavailable');
      const manifest = await response.json();
      const files = [...new Set(Object.values(manifest).flat().map(model => model.file))];
      const data = new Map(await Promise.all(files.map(async file => {
        const result = await fetch(new URL(`./data/${file}`, import.meta.url));
        if (!result.ok) throw new Error(`Stroke asset unavailable: ${file}`);
        return [file, await result.json()];
      })));
      const models = Object.fromEntries(Object.entries(manifest).map(([key, variants]) => [key, variants.map(model => {
        const source = data.get(model.file);
        const [left, bottom, right, top] = model.bounds;
        const scale = model.displaySize / Math.max(right - left, top - bottom);
        const tx = .5 - scale * (left + right) / 2;
        const ty = .5 + scale * (top + bottom) / 2;
        return {
          points: source.medians[model.strokeIndex].map(([x, y]) => ({ x: x * scale + tx, y: -y * scale + ty })),
          outline: source.strokes[model.strokeIndex],
          transform: { scale, tx, ty },
          label: model.label,
        };
      })]));
      if (!this.curriculum.setFoundationModels(models)) throw new Error('Invalid stroke model geometry');
    } catch (error) {
      console.error('Stroke models unavailable; using basic path guide', error);
    }
  }

  bindEvents() {
    document.querySelectorAll('.brush-size').forEach(button => {
      button.addEventListener('click', () => {
        if (this.busy) return;
        this.cancelPointer();
        this.brush = button.dataset.size;
        this.demoCache.clear();
        document.querySelectorAll('.brush-size').forEach(candidate => {
          const selected = candidate === button;
          candidate.classList.toggle('selected', selected);
          candidate.setAttribute('aria-pressed', String(selected));
        });
        this.render();
      });
    });
    document.querySelector('#practice-toggle').addEventListener('click', () => {
      if (this.busy) return;
      if (this.lessonMode === 'foundation') this.leaveLesson();
      else this.startFoundation();
    });
    document.querySelector('#names-toggle').addEventListener('click', () => {
      if (this.busy) return;
      if (!this.namePicker.hidden) this.leaveLesson();
      else this.openNamePicker();
    });
    document.querySelectorAll('.name-choice').forEach(button => {
      button.addEventListener('click', () => this.startName(Number(button.dataset.wordIndex)));
    });
    document.querySelector('#practice-next').addEventListener('click', () => {
      if (this.busy || !this.practice) return;
      this.cancelPointer();
      if (this.feedback?.courseCompleted) {
        this.openNamePicker();
        return;
      }
      this.feedback = null;
      this.nextTarget(true);
    });
    document.querySelector('#clear-writing').addEventListener('click', () => this.clear());
    document.querySelector('#save-writing').addEventListener('click', () => this.exportImage());
    this.canvas.addEventListener('pointerdown', event => this.beginStroke(event));
    this.canvas.addEventListener('pointermove', event => this.moveStroke(event));
    this.canvas.addEventListener('pointerup', event => this.endStroke(event));
    for (const type of ['pointercancel', 'lostpointercapture']) {
      this.canvas.addEventListener(type, event => {
        if (this.pointer?.id === event.pointerId) this.cancelPointer();
      });
    }
  }

  resetLessonInk() {
    this.cancelPointer();
    this.feedback = null;
    this.target = null;
    this.committedWriting = [];
    this.demoCache.clear();
    this.options.clearPracticeInk?.();
  }

  updateLessonControls() {
    const foundation = document.querySelector('#practice-toggle');
    const names = document.querySelector('#names-toggle');
    foundation.classList.toggle('selected', this.lessonMode === 'foundation');
    foundation.setAttribute('aria-pressed', String(this.lessonMode === 'foundation'));
    foundation.disabled = this.busy || !this.lessonsReady;
    names.classList.toggle('selected', this.lessonMode === 'names');
    names.setAttribute('aria-pressed', String(this.lessonMode === 'names'));
    names.setAttribute('aria-expanded', String(!this.namePicker.hidden));
    names.disabled = this.busy;
    document.querySelector('#practice-next').disabled = this.busy || !this.practice || !this.target;
    document.querySelectorAll('.name-choice').forEach(button => { button.disabled = this.busy || !this.namesReady; });
  }

  leaveLesson() {
    this.resetLessonInk();
    this.practice = false;
    this.lessonMode = 'free';
    this.namePicker.hidden = true;
    this.status.textContent = '自由书写';
    this.updateLessonControls();
    this.render();
    this.startLoop();
  }

  startFoundation() {
    this.resetLessonInk();
    this.curriculum.selectFoundation();
    this.practice = true;
    this.lessonMode = 'foundation';
    this.namePicker.hidden = true;
    this.updateLessonControls();
    this.nextTarget();
  }

  openNamePicker(preserveInk = this.feedback?.courseCompleted === true) {
    if (preserveInk) {
      // Keep the completed real handwriting available for rubbing/export.
      this.cancelPointer();
      this.feedback = null;
      this.demoCache.clear();
    } else this.resetLessonInk();
    this.practice = false;
    this.lessonMode = 'names';
    this.namePicker.hidden = false;
    this.status.textContent = this.namesReady ? '选择要学习的名字，艾达或伊莱。' : this.lessonsReady ? '名字笔画暂时无法加载，请重新进入页面。' : '名字笔画尚在加载。';
    this.renderNamePreviews();
    this.updateLessonControls();
    this.render();
    this.startLoop();
  }

  startName(index) {
    if (this.busy || !this.namesReady) return;
    if (!this.curriculum.selectName(index)) return;
    this.resetLessonInk();
    this.practice = true;
    this.lessonMode = 'names';
    this.namePicker.hidden = true;
    this.updateLessonControls();
    this.nextTarget();
  }

  renderNamePreviews() {
    if (!this.namesReady) return;
    const ratio = Math.min(devicePixelRatio || 1, 2);
    document.querySelectorAll('.name-choice').forEach(button => {
      const word = WORD_BANK[Number(button.dataset.wordIndex)];
      const canvas = button.querySelector('.name-preview');
      if (!word || !canvas) return;
      canvas.width = Math.round(240 * ratio);
      canvas.height = Math.round(120 * ratio);
      const context = canvas.getContext('2d');
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      Array.from(word).forEach((name, characterIndex) => {
        const character = this.characters.find(value => value.name === name);
        character?.medians.forEach((median, strokeIndex) => {
          const points = median.map(([x, y]) => ({
            x: 8 + characterIndex * 116 + 108 * (.12 + .76 * x / 1024),
            y: 6 + 108 * (.12 + .76 * (900 - y) / 1024),
          }));
          const demo = this.demoFor(points, character.types[strokeIndex], `name-preview-${name}-${strokeIndex}`, 2.6);
          this.paintDemo(context, demo, .88);
        });
      });
    });
  }

  setActive(active) {
    this.active = active;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.lastTime = performance.now();
    if (!active) this.cancelPointer();
    else { this.updatePracticeArea(); this.demoCache.clear(); this.render(); this.startLoop(); }
  }

  setReducedMotion(reduced) {
    this.reducedMotion = reduced;
    this.render();
    this.startLoop();
  }

  startLoop() {
    if (this.active && !this.frame) this.frame = requestAnimationFrame(this.tick);
  }

  tick(now) {
    this.frame = 0;
    if (!this.active) return;
    this.clock += Math.min((now - (this.lastTime || now)) / 1000, .06);
    this.lastTime = now;
    if (this.feedback && this.clock - this.feedback.start > this.feedback.duration && !this.pointer && !this.busy) {
      if (this.feedback.courseCompleted) this.openNamePicker();
      else this.nextTarget();
    }
    this.render();
    if (!this.reducedMotion || this.feedback) this.startLoop();
  }

  resize() {
    const width = this.paper.clientWidth;
    const height = this.paper.clientHeight;
    if (width < 1 || height < 1 || (width === this.width && height === this.height)) return;
    this.cancelPointer();
    this.width = width;
    this.height = height;
    this.demoCache.clear();
    this.updatePracticeArea();
    const ratio = Math.min(devicePixelRatio || 1, 2);
    for (const canvas of [this.canvas, this.guide, this.feedbackCanvas]) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      canvas.getContext('2d').setTransform(ratio, 0, 0, ratio, 0, 0);
    }
    if (this.active && (this.practice || !this.namePicker.hidden) && this.target) this.restorePracticeWriting();
    this.render();
  }

  updatePracticeArea() {
    const margin = Math.min(24, Math.min(this.width, this.height) * .05);
    const paper = this.paper.getBoundingClientRect();
    const tools = document.querySelector('.ink-tools')?.getBoundingClientRect();
    const left = margin;
    const lessons = document.querySelector('.lesson-controls')?.getBoundingClientRect();
    const top = lessons?.height
      ? Math.max(margin, (lessons.bottom - paper.top) * this.height / Math.max(1, paper.height) + margin)
      : Math.max(margin, 82);
    let right = this.width - margin;
    let bottom = this.height - margin;
    if (tools?.width && tools.height) {
      // Reserve the actual tray, including a gap, rather than stretching the
      // model to the screen's aspect ratio or drawing under mobile controls.
      if (tools.width > tools.height) {
        bottom = Math.min(bottom, (tools.top - paper.top) * this.height / Math.max(1, paper.height) - margin);
      } else {
        right = Math.min(right, (tools.left - paper.left) * this.width / Math.max(1, paper.width) - margin);
      }
    } else if (this.width <= 700) {
      bottom -= Math.min(110, this.height * .2);
    } else {
      right -= Math.min(110, this.width * .15);
    }
    right = Math.max(left + 1, right);
    bottom = Math.max(top + 1, bottom);
    const size = Math.min(right - left, bottom - top);
    this.practiceArea = { x: left + (right - left - size) / 2, y: top + (bottom - top - size) / 2, size, top };
  }

  targetInPixels() {
    const { x, y, size } = this.targetBox();
    const scale = this.target.kind === 'character' ? .76 : 1;
    const padding = (1 - scale) / 2;
    return this.target.points.map(point => ({ x: x + (padding + point.x * scale) * size, y: y + (padding + point.y * scale) * size }));
  }

  targetBox(characterIndex = this.target?.characterIndex || 0) {
    if (this.target?.mode !== 'copy') return this.practiceArea;
    const { x, y, size } = this.practiceArea;
    return { x: x + characterIndex * size * .5, y: y + size * .22, size: size * .5 };
  }

  nextTarget(replay = false) {
    if (!this.practice || !this.lessonsReady) return;
    this.updatePracticeArea();
    const next = this.curriculum.current();
    if (!next) return;
    if (this.lessonMode === 'names' && next.kind !== 'character') {
      this.openNamePicker();
      return;
    }
    const previous = this.target;
    if (!previous || next.kind === 'foundation' || previous.kind !== next.kind || previous.mode !== next.mode || previous.word !== next.word || (next.mode !== 'copy' && previous.name !== next.name)) this.committedWriting = [];
    this.showCopyHint = replay || Boolean(this.feedback && !this.feedback.accepted);
    this.target = { ...next, start: this.clock };
    this.demoCache.clear();
    if (this.practice) this.restorePracticeWriting();
    this.feedback = null;
    this.updateLessonControls();
    this.status.textContent = next.kind === 'character'
      ? `${next.mode === 'copy' ? `完整临写${next.word}。` : ''}${next.name}，第 ${next.strokeIndex + 1} 笔，${next.strokeName}。跟随起点描画。`
      : `基础练习，${next.label || next.name}。观察笔形，跟随起点描画。`;
    this.render();
    this.startLoop();
  }

  pointFromEvent(event) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
  }

  restorePracticeWriting() {
    this.options.clearPracticeInk?.();
    for (const batch of this.committedWriting) {
      const box = this.targetBox(batch.characterIndex);
      const scale = box.size / batch.box.size;
      const map = mark => ({ ...mark, x: box.x + (mark.x - batch.box.x) * scale, y: box.y + (mark.y - batch.box.y) * scale, rx: mark.rx * scale, ry: mark.ry * scale });
      const stamps = batch.stamps.map(mark => ({ ...map(mark), from: mark.from ? map(mark.from) : null }));
      this.options.paintBrush?.(stamps, { holdSeconds: 90 });
    }
  }

  beginStroke(event) {
    if (!this.active || this.busy || !this.namePicker.hidden || this.feedback || (this.practice && !this.target) || this.pointer || event.button > 0 || event.isPrimary === false) return;
    event.preventDefault();
    this.feedback = null;
    const input = event.pointerType === 'pen' ? 'pen' : 'mouse';
    if (input !== this.demoInput) {
      this.demoInput = input;
      this.demoCache.clear();
    }
    if (this.practice) this.restorePracticeWriting();
    const point = this.pointFromEvent(event);
    this.pointer = {
      id: event.pointerId,
      points: [],
      x: point.x * this.width,
      y: point.y * this.height,
      brush: new BrushStroke({ size: this.brushSize(), input }),
      profile: [],
      stamps: [],
      reference: this.practice ? this.currentDemo() : null,
    };
    this.canvas.setPointerCapture(event.pointerId);
    this.applyPoint(event);
    this.startLoop();
  }

  moveStroke(event) {
    if (!this.pointer || this.pointer.id !== event.pointerId) return;
    event.preventDefault();
    const samples = event.getCoalescedEvents?.();
    for (const sample of samples?.length ? samples : [event]) this.applyPoint(sample);
  }

  applyPoint(event) {
    const pointer = this.pointer;
    const point = this.pointFromEvent(event);
    const x = point.x * this.width;
    const y = point.y * this.height;
    const dx = x - pointer.x;
    const dy = y - pointer.y;
    const inkTime = this.options.getWritingClock?.() || 0;
    const stamps = pointer.brush.add({ x, y, time: event.timeStamp, pressure: event.pressure, pointerType: event.pointerType, ending: event.type === 'pointerup' })
      .map(stamp => ({ ...stamp, inkTime }));
    const holdSeconds = this.practice && this.target?.kind === 'character' ? 90 : 18;
    pointer.stamps.push(...stamps);
    this.options.paintBrush?.(stamps, { holdSeconds, motion: { x, y, dx, dy, speed: pointer.brush.lastSample?.speed || 0 } });
    pointer.points.push(point);
    if (pointer.brush.lastSample) pointer.profile.push({ ...pointer.brush.lastSample });
    pointer.x = x;
    pointer.y = y;
  }

  endStroke(event) {
    if (!this.pointer || this.pointer.id !== event.pointerId) return;
    event.preventDefault();
    this.applyPoint(event);
    const { points, profile, reference, stamps } = this.pointer;
    this.cancelPointer();
    if (this.practice && this.target) {
      const toPixels = point => ({ x: point.x * this.width, y: point.y * this.height });
      const routeScore = scoreStroke(points.map(toPixels), this.targetInPixels());
      const shapeQuality = brushMatch(profile, reference.profile);
      const score = Math.round(routeScore * (.75 + .25 * shapeQuality));
      const result = this.curriculum.record(score);
      if (result.accepted && this.target.kind === 'character') {
        this.committedWriting.push({ stamps, box: { ...this.targetBox() }, characterIndex: this.target.characterIndex });
      }
      this.feedback = { score, ...result, start: this.clock, duration: result.courseCompleted ? 3 : result.wordLessonCompleted ? 2 : result.characterCompleted ? 1.6 : 1.2 };
      this.status.textContent = result.courseCompleted
        ? `${this.target.word}临写完成，可选择另一个名字，或使用基础笔画按钮继续跟练。`
        : `${this.target.name}练习评分 ${score} 分。${this.target.kind === 'character' && !result.accepted ? '这一笔再跟练一次。' : ''}`;
      this.startLoop();
    }
  }

  cancelPointer() {
    const pointer = this.pointer;
    pointer?.brush.end();
    this.pointer = null;
    if (pointer && this.canvas.hasPointerCapture(pointer.id)) this.canvas.releasePointerCapture(pointer.id);
  }

  render() {
    const context = this.guide.getContext('2d');
    const feedback = this.feedbackCanvas.getContext('2d');
    context.clearRect(0, 0, this.width, this.height);
    feedback.clearRect(0, 0, this.width, this.height);
    if (!this.active || this.busy) return;
    if (this.practice && this.target) this.drawGuide(context);
    if (this.feedback) this.drawFeedback(feedback);
  }

  brushSize(mode = this.practice ? this.target?.mode : null) {
    return brushSizes[this.brush] * clamp(Math.min(this.width, this.height) / 620, .75, 1.25) * (mode === 'copy' ? .72 : 1);
  }

  demoFor(points, name, key, size = this.brushSize()) {
    const id = `${key}:${size}:${this.demoInput}`;
    if (this.demoCache.has(id)) return this.demoCache.get(id);
    const finish = /撇|捺|提|钩|悬针/.test(name) ? 'lift' : 'stop';
    const demo = createBrushDemo(points, { size, input: this.demoInput, duration: 2400, finish });
    const padding = size * 3 + 3;
    const xs = demo.stamps.map(mark => mark.x);
    const ys = demo.stamps.map(mark => mark.y);
    const left = Math.floor(Math.min(...xs) - padding);
    const top = Math.floor(Math.min(...ys) - padding);
    const width = Math.max(1, Math.ceil(Math.max(...xs) - left + padding));
    const height = Math.max(1, Math.ceil(Math.max(...ys) - top + padding));
    const ratio = Math.min(devicePixelRatio || 1, 2);
    const bitmap = document.createElement('canvas');
    bitmap.width = Math.ceil(width * ratio);
    bitmap.height = Math.ceil(height * ratio);
    const context = bitmap.getContext('2d');
    context.setTransform(ratio, 0, 0, ratio, -left * ratio, -top * ratio);
    paintBrushStamps(context, demo.stamps, '#263123');
    Object.assign(demo, { bitmap, left, top, width, height });
    this.demoCache.set(id, demo);
    return demo;
  }

  currentDemo() {
    return this.demoFor(this.targetInPixels(), this.target.label || this.target.strokeName || this.target.name, 'current');
  }

  paintDemo(context, demo, opacity) {
    context.save();
    context.globalAlpha *= opacity;
    context.drawImage(demo.bitmap, demo.left, demo.top, demo.width, demo.height);
    context.restore();
  }

  drawGuide(context) {
    if (this.feedback?.courseCompleted || this.feedback?.wordLessonCompleted) {
      const { x, y, size } = this.practiceArea;
      this.target.wordCharacters.forEach((character, index) => {
        this.drawCharacterInk(context, character, { x: x + index * size * .5, y: y + size * .24, size: size * .5 }, Infinity, -1, 'copy');
      });
      this.drawProgress(context);
      return;
    }
    this.drawProgress(context);
    this.drawPracticeGrid(context);
    if (this.target.mode === 'copy') {
      this.target.wordCharacters.forEach((character, index) => {
        const completed = index < this.target.characterIndex ? Infinity : index === this.target.characterIndex ? this.target.strokeIndex : 0;
        this.drawCharacterInk(context, character, this.targetBox(index), completed, index === this.target.characterIndex ? this.target.strokeIndex : -1, 'copy');
      });
    } else if (this.target.kind === 'character') {
      const completed = this.feedback?.characterCompleted ? Infinity : this.target.strokeIndex;
      this.drawCharacterInk(context, this.target.characterData, this.practiceArea, completed, this.target.strokeIndex);
      if (this.feedback?.characterCompleted) return;
    }
    const demo = this.currentDemo();
    const phase = (this.clock - this.target.start) % 6;
    const observing = phase < .65;
    const demonstrating = !this.pointer && !this.feedback && (this.target.mode !== 'copy' || this.showCopyHint);
    this.paintDemo(context, demo, this.pointer ? .10 : observing && demonstrating ? .38 : .16);
    const through = clamp((phase - .65) * 1000, 0, demo.duration);
    if (demonstrating && !observing && phase < 4.5) {
      context.save();
      context.globalAlpha = .76;
      paintBrushStamps(context, demo.stamps.filter(stamp => stamp.at <= through), '#263123');
      context.restore();
    }
    const start = demo.samples[0];
    const pulse = this.reducedMotion ? 0 : Math.sin(this.clock * 3) * 1.3;
    context.lineWidth = 1;
    context.strokeStyle = 'rgba(129, 81, 59, .4)';
    context.beginPath();
    context.arc(start.x, start.y, 8 + pulse, 0, Math.PI * 2);
    context.stroke();
    context.fillStyle = 'rgba(129, 81, 59, .55)';
    context.beginPath();
    context.arc(start.x, start.y, 2, 0, Math.PI * 2);
    context.fill();
    if (!this.reducedMotion && demonstrating && !observing && through < demo.duration) {
      let tip = demo.profile[0];
      for (const sample of demo.profile) {
        if (sample.time > through) break;
        tip = sample;
      }
      context.save();
      context.translate(tip.x, tip.y);
      context.rotate(-.55);
      context.scale(.7 + tip.pressure * .4, .7 + tip.pressure * .4);
      context.fillStyle = '#71654bc9';
      context.fillRect(-2.2, -42, 4.4, 29);
      context.beginPath();
      context.moveTo(-4, -13);
      context.quadraticCurveTo(-6, -4, 0, 0);
      context.quadraticCurveTo(6, -4, 4, -13);
      context.closePath();
      context.fillStyle = '#3e4535c9';
      context.fill();
      context.restore();
    }
  }

  drawPracticeGrid(context) {
    const boxes = this.target.mode === 'copy' ? [this.targetBox(0), this.targetBox(1)] : [this.practiceArea];
    context.save();
    context.strokeStyle = 'rgba(125, 121, 96, .12)';
    context.lineWidth = 1;
    context.setLineDash([3, 7]);
    for (const box of boxes) {
      const inset = box.size * .11;
      const left = box.x + inset;
      const top = box.y + inset;
      const side = box.size - inset * 2;
      context.strokeRect(left, top, side, side);
      context.beginPath();
      context.moveTo(left + side / 2, top);
      context.lineTo(left + side / 2, top + side);
      context.moveTo(left, top + side / 2);
      context.lineTo(left + side, top + side / 2);
      context.stroke();
    }
    context.restore();
  }

  drawCharacterInk(context, character, box, completed, current = -1, mode = 'guided') {
    if (!character) return;
    character.medians.forEach((median, index) => {
      const opacity = index < completed ? .30 : index === current ? 0 : .075;
      if (!opacity) return;
      const points = median.map(([x, y]) => ({
        x: box.x + box.size * (.12 + .76 * x / 1024),
        y: box.y + box.size * (.12 + .76 * (900 - y) / 1024),
      }));
      const key = `${character.name}:${index}:${box.x}:${box.y}:${box.size}`;
      const demo = this.demoFor(points, character.types[index], key, this.brushSize(mode));
      this.paintDemo(context, demo, opacity);
    });
  }

  drawProgress(context) {
    const marks = this.target.stageProgress || [];
    const active = this.target.kind === 'character' ? this.target.strokeIndex : this.target.foundationIndex;
    const { x, y, size } = this.practiceArea;
    context.save();
    marks.forEach((complete, index) => {
      context.beginPath();
      context.arc(x + size / 2 + (index - (marks.length - 1) / 2) * 14, y + size * .94, index === active ? 3.2 : 2, 0, Math.PI * 2);
      context.fillStyle = complete || this.feedback?.courseCompleted ? '#8b9c71' : '#9ca58a38';
      context.fill();
      if (index === active) {
        context.strokeStyle = '#71855c99';
        context.lineWidth = 1;
        context.stroke();
      }
    });
    context.restore();
  }

  drawFeedback(context) {
    const age = this.clock - this.feedback.start;
    const reveal = this.reducedMotion ? 1 : clamp(age / .65, 0, 1);
    const fade = this.reducedMotion ? 1 : Math.min(1, (this.feedback.duration - age) / .4);
    const centerX = this.practiceArea.x + this.practiceArea.size / 2;
    const centerY = Math.max(65, this.practiceArea.top + this.practiceArea.size * .09);
    const radius = 20;
    context.save();
    context.globalAlpha = Math.max(0, fade);
    context.lineWidth = 2.2;
    context.strokeStyle = '#68764c24';
    context.beginPath();
    context.arc(centerX, centerY, radius, 0, Math.PI * 2);
    context.stroke();
    context.strokeStyle = '#657c4e';
    context.beginPath();
    context.arc(centerX, centerY, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * this.feedback.score / 100 * reveal);
    context.stroke();
    for (let index = 0; index < 5; index++) {
      const lit = this.feedback.score >= (index + 1) * 18;
      const scale = this.reducedMotion ? 1 : clamp((age - index * .09) / .25, 0, 1);
      context.save();
      context.translate(centerX + (index - 2) * 25, centerY + 40);
      context.scale(scale, scale);
      context.beginPath();
      for (let point = 0; point < 10; point++) {
        const angle = -Math.PI / 2 + point * Math.PI / 5;
        const distance = point % 2 ? 3.7 : 8;
        context[point ? 'lineTo' : 'moveTo'](Math.cos(angle) * distance, Math.sin(angle) * distance);
      }
      context.closePath();
      context.fillStyle = lit ? '#9b8048' : '#9c9d882c';
      context.fill();
      context.restore();
    }
    context.restore();
  }

  setBusy(busy) {
    this.busy = busy;
    document.querySelectorAll('.brush-size, #clear-writing, #save-writing').forEach(button => { button.disabled = busy; });
    this.updateLessonControls();
    this.render();
  }

  async animate(element, frames, duration) {
    if (this.reducedMotion) return;
    const animation = element.animate(frames, { duration, easing: 'cubic-bezier(.22, 1, .36, 1)', fill: 'forwards' });
    try { await animation.finished; } finally { animation.cancel(); }
  }

  async clear() {
    if (this.busy) return;
    this.cancelPointer();
    this.feedback = null;
    this.committedWriting = [];
    if (this.practice) this.curriculum.restartCharacter();
    this.setBusy(true);
    this.wash.hidden = false;
    document.body.classList.add('is-washing');
    try {
      await this.animate(this.wash, [
        { clipPath: 'circle(0% at 96% 90%)', opacity: .25 },
        { clipPath: 'circle(150% at 96% 90%)', opacity: 1 },
      ], 700);
      this.options.clearInk?.();
      await this.animate(this.wash, [{ opacity: 1 }, { opacity: 0 }], 350);
      this.status.textContent = '笔墨已洗清';
      if (this.practice) this.nextTarget();
    } catch (error) {
      this.status.textContent = '洗笔暂未完成，请重试';
      console.error('Ink wash failed', error);
    } finally {
      this.wash.hidden = true;
      document.body.classList.remove('is-washing');
      this.setBusy(false);
      this.startLoop();
    }
  }

  async exportImage() {
    if (this.busy) return;
    this.cancelPointer();
    this.setBusy(true);
    let url;
    document.body.classList.add('is-printing');
    try {
      const background = this.options.captureBackground?.();
      if (!background) throw new Error('Ink frame is unavailable');
      const output = document.createElement('canvas');
      output.width = background.width;
      output.height = background.height;
      const context = output.getContext('2d');
      context.fillStyle = '#f7f3e8';
      context.fillRect(0, 0, output.width, output.height);
      context.drawImage(background, 0, 0);
      const blob = await new Promise(resolve => output.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('Image export failed');
      url = URL.createObjectURL(blob);
      this.printSheet.style.backgroundImage = `url("${url}")`;
      this.printSheet.hidden = false;
      await this.animate(this.printSheet, [
        { transform: 'translateY(8%) scale(.96)', opacity: 0 },
        { transform: 'translateY(0) scale(1)', opacity: 1, offset: .45 },
        { transform: 'translateY(-4%) scale(.96)', opacity: 1 },
      ], 850);
      const link = document.createElement('a');
      link.href = url;
      link.download = `Harvey-ink-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
      link.click();
      await this.animate(this.printSheet, [
        { transform: 'translateY(-4%) scale(.96)', opacity: 1 },
        { transform: 'translateY(-15%) scale(.88)', opacity: 0 },
      ], 400);
      this.status.textContent = '拓印已生成，可在浏览器下载中查看';
    } catch (error) {
      this.status.textContent = '拓印暂未保存，请重试';
      console.error('Ink print failed', error);
    } finally {
      this.printSheet.hidden = true;
      this.printSheet.style.backgroundImage = '';
      document.body.classList.remove('is-printing');
      this.setBusy(false);
      if (url) setTimeout(() => URL.revokeObjectURL(url), 1500);
    }
  }
}
