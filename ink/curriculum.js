// Learning progress is separate from artwork. No pointer samples or ink pixels
// are saved, and the previous writing app's storage key is never touched.
export const PRACTICE_STORAGE_KEY = 'harvey-ink-practice-v1';
export const WORD_BANK = ['艾达', '伊莱'];

const PASS_FOUNDATION = 65;
const PASS_CHARACTER = 60;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// Ordered, finite variations: progress moves through this sequence rather than
// selecting a random stroke or a random position on the paper.
export const FOUNDATION_STROKES = [
  { key: 'heng', name: '横', variants: [
    [[.24, .51], [.39, .49], [.58, .48], [.76, .46]],
    [[.31, .48], [.44, .475], [.58, .47], [.69, .455]],
    [[.23, .46], [.40, .465], [.59, .455], [.75, .44]],
  ] },
  { key: 'shu', name: '竖', variants: [
    [[.50, .24], [.49, .40], [.50, .59], [.49, .77]],
    [[.46, .30], [.465, .44], [.46, .59], [.455, .72]],
    [[.54, .23], [.53, .41], [.525, .60], [.51, .78]],
  ] },
  { key: 'pie', name: '撇', variants: [
    [[.65, .25], [.63, .39], [.56, .54], [.45, .67], [.29, .77]],
    [[.61, .31], [.59, .43], [.53, .55], [.42, .65], [.33, .71]],
    [[.64, .24], [.62, .42], [.56, .59], [.46, .72], [.34, .80]],
  ] },
  { key: 'na', name: '捺', variants: [
    [[.27, .25], [.34, .43], [.45, .59], [.60, .72], [.77, .77]],
    [[.32, .31], [.38, .46], [.49, .60], [.62, .69], [.74, .72]],
    [[.25, .32], [.36, .47], [.49, .62], [.63, .73], [.80, .77]],
  ] },
  { key: 'dian', name: '点', variants: [
    [[.43, .38], [.47, .43], [.50, .49], [.53, .56]],
    [[.45, .37], [.49, .42], [.53, .47], [.56, .53]],
    [[.42, .40], [.46, .445], [.49, .50], [.515, .57]],
  ] },
  { key: 'ti', name: '提', variants: [
    [[.31, .65], [.42, .57], [.54, .46], [.66, .34]],
    [[.36, .63], [.47, .54], [.57, .44], [.65, .35]],
    [[.30, .68], [.41, .60], [.54, .49], [.68, .36]],
  ] },
  { key: 'zhe', name: '折', variants: [
    [[.27, .33], [.47, .31], [.68, .30], [.67, .48], [.65, .72]],
    [[.30, .36], [.47, .34], [.64, .33], [.63, .49], [.61, .70]],
    [[.26, .29], [.48, .28], [.70, .27], [.68, .49], [.66, .75]],
  ] },
  { key: 'gou', name: '钩', variants: [
    [[.55, .25], [.55, .44], [.54, .64], [.53, .73], [.48, .72], [.41, .66]],
    [[.53, .30], [.53, .46], [.525, .63], [.51, .71], [.47, .70], [.40, .64]],
    [[.56, .23], [.56, .44], [.55, .64], [.535, .77], [.49, .755], [.41, .68]],
  ] },
  { key: 'hengzhezhepie', name: '横折折撇', variants: [
    [[.28, .32], [.61, .29], [.47, .46], [.60, .46], [.49, .64], [.32, .77]],
    [[.31, .35], [.60, .32], [.48, .47], [.59, .48], [.49, .64], [.35, .74]],
    [[.27, .30], [.63, .27], [.47, .46], [.61, .47], [.48, .67], [.30, .79]],
  ] },
];

function samplePolyline(points, count = 65) {
  const lengths = [0];
  for (let index = 1; index < points.length; index++) {
    lengths.push(lengths[index - 1] + Math.hypot(points[index][0] - points[index - 1][0], points[index][1] - points[index - 1][1]));
  }
  const total = lengths[lengths.length - 1];
  let segment = 1;
  return Array.from({ length: count }, (_, index) => {
    const at = total * index / (count - 1);
    while (segment < points.length - 1 && lengths[segment] < at) segment++;
    const a = points[segment - 1];
    const b = points[segment];
    const t = (at - lengths[segment - 1]) / Math.max(1e-8, lengths[segment] - lengths[segment - 1]);
    return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t };
  });
}

function emptyState() {
  return { version: 2, phase: 'foundation', index: 0, round: 0, cycle: 0, wordIndex: 0, characterIndex: 0, strokeIndex: 0, history: {}, nameProgress: {} };
}

function safeInteger(value, max = 1000000) {
  return Number.isInteger(value) ? clamp(value, 0, max) : 0;
}

function readState() {
  const state = emptyState();
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(PRACTICE_STORAGE_KEY) || 'null');
    if (!saved || ![1, 2].includes(saved.version)) return state;
    state.index = safeInteger(saved.index, FOUNDATION_STROKES.length - 1);
    state.round = safeInteger(saved.round);
    state.cycle = safeInteger(saved.cycle);
    if (saved.version === 2) {
      state.wordIndex = safeInteger(saved.wordIndex, WORD_BANK.length - 1);
      for (const name of WORD_BANK) {
        const progress = saved.nameProgress?.[name];
        if (!progress || !['character', 'word'].includes(progress.phase)) continue;
        state.nameProgress[name] = {
          phase: progress.phase,
          characterIndex: safeInteger(progress.characterIndex, 1),
          strokeIndex: safeInteger(progress.strokeIndex, 30),
          completed: progress.completed === true,
        };
      }
    } else if ((!Number.isInteger(saved.wordIndex) || saved.wordIndex === 0) && ['character', 'word'].includes(saved.phase)) {
      // Earlier indexes 1..3 meant 大小 / 山水 / 日月, never 伊莱.
      state.nameProgress['艾达'] = {
        phase: saved.phase,
        characterIndex: safeInteger(saved.characterIndex, 1),
        strokeIndex: safeInteger(saved.strokeIndex, 30),
        completed: false,
      };
    }
    for (const stroke of FOUNDATION_STROKES) {
      const attempts = saved.history?.[stroke.key];
      if (!Array.isArray(attempts)) continue;
      state.history[stroke.key] = attempts.slice(-3).filter(attempt =>
        attempt && Number.isFinite(attempt.score) && Number.isInteger(attempt.variant)
        && attempt.variant >= 0 && attempt.variant < stroke.variants.length,
      ).map(attempt => ({ score: clamp(attempt.score, 0, 100), variant: attempt.variant }));
    }
  } catch {
    // Private browsing, blocked storage and invalid prior data are nonfatal.
  }
  return state;
}

export class InkCurriculum {
  constructor() {
    this.state = readState();
    this.characters = [];
    this.foundationModels = Object.create(null);
  }

  save() {
    if (['character', 'word'].includes(this.state.phase)) {
      this.state.nameProgress[WORD_BANK[this.state.wordIndex]] = {
        phase: this.state.phase,
        characterIndex: this.state.characterIndex,
        strokeIndex: this.state.strokeIndex,
        completed: false,
      };
    }
    try { globalThis.localStorage?.setItem(PRACTICE_STORAGE_KEY, JSON.stringify(this.state)); }
    catch { /* Practice also works without persistent browser storage. */ }
  }

  mastered(key) {
    const passed = (this.state.history[key] || []).filter(attempt => attempt.score >= PASS_FOUNDATION);
    return new Set(passed.map(attempt => attempt.variant)).size >= 2;
  }

  foundationProgress() {
    return FOUNDATION_STROKES.map(stroke => this.mastered(stroke.key));
  }

  currentWordCharacters() {
    return Array.from(WORD_BANK[this.state.wordIndex], name => this.characters.find(character => character.name === name));
  }

  selectFoundation() {
    this.save();
    this.state.phase = 'foundation';
    this.state.characterIndex = 0;
    this.state.strokeIndex = 0;
    this.save();
    return this.current();
  }

  selectName(index) {
    if (!Number.isInteger(index) || index < 0 || index >= WORD_BANK.length) return null;
    const characters = Array.from(WORD_BANK[index], name => this.characters.find(character => character.name === name));
    if (!characters.every(Boolean)) return null;
    this.save();
    const progress = this.state.nameProgress[WORD_BANK[index]];
    this.state.wordIndex = index;
    this.state.phase = progress && !progress.completed ? progress.phase : 'character';
    // Ink stays in page memory, so rebuild the current character on re-entry.
    // A whole-name copy starts with both characters empty.
    this.state.characterIndex = this.state.phase === 'word' || !progress || progress.completed ? 0 : progress.characterIndex;
    this.state.strokeIndex = 0;
    this.save();
    return this.current();
  }

  setFoundationModels(models) {
    if (!models || typeof models !== 'object' || Array.isArray(models)) return false;
    const next = Object.create(null);
    for (const stroke of FOUNDATION_STROKES) {
      const variants = models[stroke.key];
      if (!Array.isArray(variants) || variants.length !== stroke.variants.length) return false;
      if (!variants.every(model =>
        model && Array.isArray(model.points) && model.points.length >= 2
        && model.points.every(point => point && Number.isFinite(point.x) && Number.isFinite(point.y))
        && model.points.some(point => point.x !== model.points[0].x || point.y !== model.points[0].y)
        && typeof model.outline === 'string' && model.outline.trim().length > 0
        && model.transform && Number.isFinite(model.transform.scale) && model.transform.scale > 0
        && Number.isFinite(model.transform.tx) && Number.isFinite(model.transform.ty),
      )) return false;
      next[stroke.key] = variants.map(model => ({
        points: model.points.map(({ x, y }) => ({ x, y })),
        outline: model.outline,
        transform: { scale: model.transform.scale, tx: model.transform.tx, ty: model.transform.ty },
        label: typeof model.label === 'string' ? model.label : stroke.name,
      }));
    }
    // Model assets change the demonstration, never the learner's progress.
    this.foundationModels = next;
    return true;
  }

  setCharacters(characters) {
    if (!Array.isArray(characters) || characters.length < 2 || !characters.every(character =>
      character && typeof character.name === 'string' && Array.isArray(character.strokes)
      && Array.isArray(character.medians) && character.medians.length > 0
      && character.strokes.length === character.medians.length
      && character.strokes.every(stroke => typeof stroke === 'string')
      && character.medians.every(median => Array.isArray(median) && median.length >= 2
        && median.every(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))),
    )) return false;
    const names = new Set(characters.map(character => character.name));
    if (names.size !== characters.length || !WORD_BANK.every(word => Array.from(word).every(name => names.has(name)))) return false;
    this.characters = characters;
    if (this.state.phase === 'character' || this.state.phase === 'word') {
      const wordCharacters = this.currentWordCharacters();
      this.state.characterIndex = Math.min(this.state.characterIndex, wordCharacters.length - 1);
      this.state.strokeIndex = Math.min(this.state.strokeIndex, wordCharacters[this.state.characterIndex].medians.length - 1);
    }
    this.save();
    return true;
  }

  fallBackToFoundation() {
    // Name cursors remain separately stored even if a data asset cannot load.
    this.selectFoundation();
  }

  current() {
    if (this.state.phase === 'character' || this.state.phase === 'word') {
      const wordCharacters = this.currentWordCharacters();
      const character = wordCharacters[this.state.characterIndex];
      if (!wordCharacters.every(Boolean) || !character) return null;
      const index = this.state.strokeIndex;
      return {
        kind: 'character', name: character.name,
        mode: this.state.phase === 'word' ? 'copy' : 'guided',
        word: WORD_BANK[this.state.wordIndex], wordIndex: this.state.wordIndex, wordCharacters,
        key: `${this.state.phase}-${this.state.wordIndex}-${this.state.characterIndex}-${index}`,
        strokeName: character.types?.[index] || '',
        points: samplePolyline(character.medians[index].map(([x, y]) => [x / 1024, (900 - y) / 1024])),
        variant: 0, round: this.state.round, cycle: this.state.cycle,
        stageProgress: character.medians.map((_, strokeIndex) => strokeIndex < index),
        characterIndex: this.state.characterIndex, relativeCharacterIndex: this.state.characterIndex, strokeIndex: index,
        characterData: character,
      };
    }
    const stroke = FOUNDATION_STROKES[this.state.index];
    const variant = (this.state.round + this.state.cycle) % stroke.variants.length;
    const model = this.foundationModels[stroke.key]?.[variant];
    let points = samplePolyline(model ? model.points.map(({ x, y }) => [x, y]) : stroke.variants[variant]);
    if (!model && stroke.key === 'hengzhezhepie') {
      // Practice the same compound movement later used in 达. Keep source data
      // in its licensed JSON asset and transform its coordinates at runtime.
      const source = this.characters.find(character => character.name === '达')?.medians[4];
      if (source) {
        const xs = source.map(point => point[0]);
        const ys = source.map(point => point[1]);
        const left = Math.min(...xs);
        const right = Math.max(...xs);
        const top = Math.max(...ys);
        const bottom = Math.min(...ys);
        const scale = [0.52, 0.46, 0.57][variant] / Math.max(right - left, top - bottom, 1);
        const centerX = [0.49, 0.51, 0.48][variant];
        points = samplePolyline(source.map(([x, y]) => [
          centerX + (x - (left + right) / 2) * scale,
          .51 + ((top + bottom) / 2 - y) * scale,
        ]));
      }
    }
    return {
      kind: 'foundation', name: stroke.name, strokeName: stroke.name, key: stroke.key,
      word: WORD_BANK[this.state.wordIndex], wordIndex: this.state.wordIndex,
      points, variant, foundationIndex: this.state.index,
      ...(model ? { outline: model.outline, outlineTransform: { ...model.transform }, label: model.label } : {}),
      round: this.state.round, cycle: this.state.cycle,
      stageProgress: this.foundationProgress(),
    };
  }

  // Replaying a demonstration never advances the course or awards mastery.
  replay() { return this.current(); }

  record(score) {
    const result = { accepted: false, characterCompleted: false, wordLessonCompleted: false, courseCompleted: false };
    const target = this.current();
    if (!target || !Number.isFinite(score)) return result;
    score = clamp(score, 0, 100);
    if (target.kind === 'foundation') {
      const attempts = this.state.history[target.key] || [];
      this.state.history[target.key] = [...attempts, { score, variant: target.variant }].slice(-3);
      result.accepted = score >= PASS_FOUNDATION;
      this.state.index = (this.state.index + 1) % FOUNDATION_STROKES.length;
      if (!this.state.index) this.state.round++;
    } else if (score >= PASS_CHARACTER) {
      result.accepted = true;
      this.state.strokeIndex++;
      if (this.state.strokeIndex >= target.characterData.medians.length) {
        result.characterCompleted = true;
        this.state.characterIndex++;
        this.state.strokeIndex = 0;
        if (this.state.characterIndex >= target.wordCharacters.length) {
          if (this.state.phase === 'character') {
            result.wordLessonCompleted = true;
            this.state.phase = 'word';
            this.state.characterIndex = 0;
          } else {
            result.courseCompleted = true;
            this.state.nameProgress[target.word] = { phase: 'character', characterIndex: 0, strokeIndex: 0, completed: true };
            this.state.phase = 'foundation';
            this.state.characterIndex = 0;
            this.state.strokeIndex = 0;
          }
        }
      }
    }
    this.save();
    return result;
  }

  // Washing restarts a guided character or the complete word-copy attempt.
  // It does not erase earned foundational skill or skip an unfinished stroke.
  restartCharacter() {
    if (this.state.phase === 'character' || this.state.phase === 'word') {
      this.state.strokeIndex = 0;
      if (this.state.phase === 'word') this.state.characterIndex = 0;
      this.save();
    }
    return this.current();
  }
}
