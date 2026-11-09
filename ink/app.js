import { SpinUnlock } from './spin-unlock.js?v=1.16.2';
import { IntroAudio } from './intro-audio.js?v=1.16.0';
import { WaterAudio } from './water-audio.js?v=1.16.0';

const intro = document.querySelector('#intro');
const world = document.querySelector('#ink-world');
const enter = document.querySelector('#enter');
const enterHint = document.querySelector('#enter-hint');
const spinPanel = document.querySelector('#spin-unlock');
const flight = document.querySelector('#wordmark-flight');
const wordmark = document.querySelector('#wordmark');
const trail = document.querySelector('#meteor-trail');
const iris = document.querySelector('#iris');
const surface = document.querySelector('#ink-surface');
const status = document.querySelector('#writing-status');
const flowButton = document.querySelector('#writing-flow');
const musicButton = document.querySelector('#music-toggle');
const inkMusic = document.querySelector('#ink-music');
const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
const reducedMotion = () => motionPreference.matches;
let scene;
let scenePromise;
let transitionRunning = false;
let inWorld = false;
let unlocked = false;
let openingKeyboard = false;
let flightFrame = 0;
let openingAnimation;
const greenSilhouette = document.createElement('canvas');
const greenImprint = document.createElement('canvas');
let writerPromise;
let writer;
let paused = reducedMotion();
let waterMode = 'heavy';
let musicEnabled = true;
const introAudio = new IntroAudio(document.querySelector('#intro-sound'));
const waterAudio = new WaterAudio();
inkMusic.volume = .8;

function playInkMusic() {
  if (!musicEnabled || document.hidden || !inkMusic.paused) return;
  inkMusic.play().catch(() => {});
}

const smoothstep = (min, max, value) => {
  const t = Math.max(0, Math.min(1, (value - min) / (max - min)));
  return t * t * (3 - 2 * t);
};

async function prepareWordmark() {
  const original = new Image();
  original.src = './assets/harvey-original.jpeg';
  await original.decode();

  // These loose source-image contours exclude the pencil-shaded paper.
  // All visible lettering comes from the supplied drawing, preserving its proportions.
  const contours = [
    [[210, 273], [339, 265], [350, 451], [205, 460]],
    [[339, 363], [391, 338], [420, 337], [431, 429], [340, 430]],
    [[434, 342], [468, 326], [495, 333], [511, 371], [493, 387], [476, 376], [476, 421], [430, 421]],
    [[509, 344], [538, 344], [548, 368], [556, 352], [580, 350], [575, 390], [556, 419], [535, 421]],
    [[569, 357], [601, 349], [626, 358], [637, 386], [629, 402], [636, 425], [604, 442], [569, 438], [550, 416], [550, 389]],
    [[621, 366], [644, 360], [672, 393], [691, 373], [714, 371], [719, 399], [679, 453], [649, 488], [619, 480], [642, 447], [657, 427]],
  ];
  const crop = document.createElement('canvas');
  crop.width = 520;
  crop.height = 240;
  const context = crop.getContext('2d', { willReadFrequently: true });
  context.save();
  context.beginPath();
  for (const contour of contours) {
    contour.forEach(([x, y], index) => {
      context[index === 0 ? 'moveTo' : 'lineTo'](x - 200, y - 260);
    });
    context.closePath();
  }
  context.clip();
  context.drawImage(original, -200, -260);
  context.restore();
  const pixels = context.getImageData(0, 0, crop.width, crop.height);
  for (let i = 0; i < pixels.data.length; i += 4) {
    const [r, g, b] = pixels.data.subarray(i, i + 3);
    const greenDominance = (g - r) / Math.max(g, 1);
    const saturation = (Math.max(r, g, b) - Math.min(r, g, b)) / Math.max(r, g, b, 1);
    const alpha = smoothstep(.09, .26, greenDominance) * smoothstep(.32, .61, saturation);
    pixels.data[i + 3] *= alpha;
  }
  context.putImageData(pixels, 0, 0);
  wordmark.getContext('2d').drawImage(crop, 0, 0, wordmark.width, wordmark.height);
  prepareGreenImprint();
}

function prepareGreenImprint() {
  greenSilhouette.width = wordmark.width;
  greenSilhouette.height = wordmark.height;
  const silhouette = greenSilhouette.getContext('2d');
  silhouette.drawImage(wordmark, 0, 0);
  silhouette.globalCompositeOperation = 'source-in';
  silhouette.fillStyle = '#568b20';
  silhouette.fillRect(0, 0, greenSilhouette.width, greenSilhouette.height);

  // Extrude the actual hand-drawn shapes into one connected, permanent mark.
  // The 310px left inset leaves room for the diagonal shadow without cropping it.
  greenImprint.width = 1400;
  greenImprint.height = 840;
  const context = greenImprint.getContext('2d');
  for (let depth = 140; depth >= 4; depth--) {
    const distance = depth / 140;
    context.drawImage(greenSilhouette, 310 - distance * 270, distance * 300);
  }
  context.globalCompositeOperation = 'source-in';
  context.fillStyle = '#6e9842';
  context.fillRect(0, 0, greenImprint.width, greenImprint.height);
  context.globalCompositeOperation = 'source-atop';
  // Fixed, uneven hatching gives the large mark the grain of coloured pencil.
  for (let index = 0; index < 420; index++) {
    const x = (index * 61.803) % greenImprint.width;
    const y = (index * 47.119) % greenImprint.height;
    context.strokeStyle = index % 3 === 0 ? '#d1de8a80' : '#315f203b';
    context.lineWidth = 1 + (index % 4);
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(x - 90 - (index % 70), y + 100 + (index % 78));
    context.stroke();
  }
  for (let index = 0; index < 10000; index++) {
    const x = (index * 71.713) % greenImprint.width;
    const y = (index * 39.917) % greenImprint.height;
    context.fillStyle = index % 2 ? '#ecedbc50' : '#254a2525';
    context.fillRect(x, y, 1.3, 2.1);
  }
}

function resizeTrail() {
  const ratio = Math.min(devicePixelRatio || 1, 2);
  trail.width = innerWidth * ratio;
  trail.height = innerHeight * ratio;
  trail.getContext('2d').setTransform(ratio, 0, 0, ratio, 0, 0);
}

function openingPose(bounds, seconds) {
  const progress = Math.max(0, Math.min(1, seconds / 1.28));
  const settle = Math.max(0, (progress - .73) / .27);
  const distance = progress < .73 ? .94 * progress / .73 : .94 + .06 * (1 - (1 - settle) ** 3);
  return {
    x: (-bounds.left - bounds.width * 1.1) * (1 - distance),
    y: (innerHeight - bounds.top + bounds.height * .2) * (1 - distance),
    scale: .86 + distance * .14,
    progress,
  };
}

function drawGreenTail(bounds, pose, seconds) {
  const context = trail.getContext('2d');
  context.clearRect(0, 0, innerWidth, innerHeight);
  const width = bounds.width * pose.scale;
  const height = bounds.height * pose.scale;
  const left = bounds.left + bounds.width / 2 + pose.x - width / 2;
  const top = bounds.top + bounds.height / 2 + pose.y - height / 2;
  const pixelScale = width / wordmark.width;
  context.save();
  context.globalAlpha = .70;
  context.drawImage(greenImprint, left - 310 * pixelScale, top, greenImprint.width * pixelScale, greenImprint.height * pixelScale);
  context.globalAlpha = 1;
  context.globalCompositeOperation = 'source-atop';
  // The mass stays visible; only the pencil bands travel through it.
  for (let index = 0; index < 90; index++) {
    const phase = (seconds * .38 + index * .618) % 1;
    const headX = left + width * (index / 88);
    const headY = top + height * .28;
    context.strokeStyle = index % 2 ? 'rgba(224, 228, 131, .22)' : 'rgba(43, 98, 17, .19)';
    context.lineWidth = 1 + width / 320;
    context.beginPath();
    context.moveTo(headX - phase * width * .32, headY + phase * height * 1.42);
    context.lineTo(headX - (phase + .33) * width * .32, headY + (phase + .33) * height * 1.42);
    context.stroke();
  }
  context.restore();

  // Delayed copies echo analog television title trails during the entrance.
  if (seconds < 1.68 && !reducedMotion()) {
    for (let layer = 7; layer >= 1; layer--) {
      const echo = openingPose(bounds, seconds - layer * .055);
      const echoWidth = bounds.width * echo.scale;
      const echoHeight = bounds.height * echo.scale;
      context.globalAlpha = (.38 - layer * .035) * (1 - smoothstep(1.28, 1.68, seconds));
      context.drawImage(greenSilhouette,
        bounds.left + bounds.width / 2 + echo.x - echoWidth / 2,
        bounds.top + bounds.height / 2 + echo.y - echoHeight / 2,
        echoWidth, echoHeight);
    }
    context.globalAlpha = 1;
  }
}

function playOpening() {
  cancelAnimationFrame(flightFrame);
  intro.classList.remove('ready');
  enter.hidden = false;
  enterHint.hidden = false;
  enter.disabled = true;
  enterHint.disabled = true;
  resizeTrail();
  const start = performance.now();
  let titleCue = false;
  openingAnimation = now => {
    if (inWorld || document.hidden) return;
    const seconds = reducedMotion() ? 2 : (now - start) / 1000;
    const bounds = enter.getBoundingClientRect();
    const pose = openingPose(bounds, seconds);
    flight.style.opacity = '1';
    flight.style.transform = `translate3d(${pose.x}px, ${pose.y}px, 0) scale(${pose.scale})`;
    // Cue the duet when the visible part of the drawing crosses the corner.
    const visibleRight = bounds.left + bounds.width * (.5 + pose.scale * .46) + pose.x;
    const visibleTop = bounds.top + bounds.height * (.5 - pose.scale * .40) + pose.y;
    if (!titleCue && visibleRight > 0 && visibleTop < innerHeight) {
      titleCue = true;
      introAudio.reveal();
    }
    drawGreenTail(bounds, pose, seconds);
    if (pose.progress === 1 && !intro.classList.contains('ready')) {
      intro.classList.add('ready');
      enter.disabled = false;
      enterHint.disabled = false;
      if (openingKeyboard) {
        enterHint.focus({ preventScroll: true });
        openingKeyboard = false;
      }
    }
    if (!reducedMotion()) flightFrame = requestAnimationFrame(openingAnimation);
  };
  flightFrame = requestAnimationFrame(openingAnimation);
}

function ensureWriter() {
  if (!writerPromise) {
    writerPromise = import('./writer.js?v=1.16.0').then(({ InkWriter }) => {
      writer = new InkWriter({
        reducedMotion: reducedMotion(),
        paintBrush: (...args) => scene?.paintBrushStamps(...args),
        getWritingClock: () => scene?.getWritingClock() || 0,
        getWaterMode: () => waterMode,
        clearPracticeInk: () => scene?.clearWriting(),
        clearInk: () => scene?.clearWriting(),
        captureBackground: () => scene?.capture(),
      });
      return writer;
    }).catch(error => {
      writerPromise = undefined;
      document.querySelector('#writing-status').textContent = '书写工具加载失败，请返回开场后重试';
      console.error('Writing tools could not load', error);
    });
  }
  return writerPromise;
}

function ensureScene() {
  if (!scenePromise) {
    scenePromise = import('./ink.js?v=1.16.0').then(({ InkScene }) => {
      scene = new InkScene(surface, {
        reducedMotion: reducedMotion(),
        onFallback: () => { status.textContent = '纸上留墨 · 轻量背景'; },
      });
      scene.setPaused(paused);
      scene.setPalette('sumi');
      scene.setWaterMode(waterMode);
      return scene;
    }).catch((error) => {
      scenePromise = undefined;
      status.textContent = '水墨未能加载，可返回开场后重试';
      console.error('Ink scene could not load', error);
      return undefined;
    });
  }
  return scenePromise;
}

async function irisTransition(x, y, changePage, keyboard) {
  if (reducedMotion() || keyboard) {
    changePage();
    return;
  }
  const diameter = Math.ceil(Math.hypot(innerWidth, innerHeight) * 2);
  iris.style.width = `${diameter}px`;
  iris.style.height = `${diameter}px`;
  iris.style.left = `${x - diameter / 2}px`;
  iris.style.top = `${y - diameter / 2}px`;
  iris.style.display = 'block';
  const bloom = iris.animate([
    { transform: 'scale(.015)', opacity: .85 },
    { transform: 'scale(1)', opacity: 1 },
  ], { duration: 670, easing: 'cubic-bezier(.66, 0, .22, 1)', fill: 'forwards' });
  await bloom.finished;
  changePage();
  const reveal = iris.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 430, easing: 'ease-out', fill: 'forwards' });
  await reveal.finished;
  iris.style.display = 'none';
  iris.getAnimations().forEach(animation => animation.cancel());
}

async function enterWorld(event) {
  if (transitionRunning || inWorld || !unlocked || !intro.classList.contains('ready')) return;
  transitionRunning = true;
  waterAudio.start(waterMode);
  playInkMusic();
  unlock.setActive(false);
  cancelAnimationFrame(flightFrame);
  flight.style.transform = 'none';
  flight.style.opacity = '1';
  intro.classList.add('ready');
  // Preload the scene while the expanding ink covers the page.
  const loading = ensureScene();
  const writing = ensureWriter();
  const keyboard = event.detail === 0;
  const x = keyboard ? innerWidth / 2 : event.clientX;
  const y = keyboard ? innerHeight / 2 : event.clientY;
  await irisTransition(x, y, () => {
    inWorld = true;
    intro.hidden = true;
    world.inert = false;
    world.removeAttribute('aria-hidden');
    document.querySelector('meta[name="theme-color"]').content = '#f3efe3';
  }, keyboard);
  const loaded = await loading;
  await writing;
  loaded?.setActive(inWorld && !document.hidden);
  writer?.setActive(inWorld && !document.hidden);
  if (inWorld) document.querySelector('#back').focus({ preventScroll: true });
  transitionRunning = false;
}

async function returnToIntro(event) {
  if (transitionRunning) return;
  transitionRunning = true;
  inWorld = false;
  pauseWorldAudio();
  scene?.setActive(false);
  writer?.setActive(false);
  intro.hidden = false;
  world.inert = true;
  world.setAttribute('aria-hidden', 'true');
  document.querySelector('meta[name="theme-color"]').content = '#ffdf00';
  resetOpening();
  if (event?.type === 'keydown' || event?.detail === 0) {
    document.querySelector('#spin-button').focus({ preventScroll: true });
  }
  transitionRunning = false;
}

enter.addEventListener('click', enterWorld);
enterHint.addEventListener('click', enterWorld);
flowButton.addEventListener('click', () => {
  const modes = ['heavy', 'light', 'still'];
  waterMode = modes[(modes.indexOf(waterMode) + 1) % modes.length];
  const labels = {
    heavy: '小水流：有轻微流水声，新笔迹较快淡去。点击切换细水。',
    light: '细水：水声更轻，新笔迹缓慢淡去。点击停水。',
    still: '停水：无水声，新笔迹保留。点击开启小水流。',
  };
  const icons = { heavy: 'water-flow-icon', light: 'water-light-icon', still: 'water-still-icon' };
  flowButton.setAttribute('aria-label', labels[waterMode]);
  flowButton.dataset.waterMode = waterMode;
  flowButton.querySelector('use').setAttribute('href', `#${icons[waterMode]}`);
  flowButton.classList.toggle('selected', waterMode !== 'still');
  scene?.setWaterMode(waterMode);
  waterAudio.start(waterMode);
});
musicButton.addEventListener('click', () => {
  musicEnabled = !musicEnabled;
  musicButton.setAttribute('aria-pressed', String(musicEnabled));
  if (musicEnabled) playInkMusic();
  else inkMusic.pause();
});

function resumeWorldAudio(event) {
  if (!inWorld || document.hidden || musicButton.contains(event?.target ?? null)) return;
  waterAudio.start(waterMode);
  playInkMusic();
}

function pauseWorldAudio() {
  waterAudio.stop();
  inkMusic.pause();
}

world.addEventListener('pointerdown', resumeWorldAudio, { passive: true });
world.addEventListener('keydown', resumeWorldAudio);
window.addEventListener('focus', () => resumeWorldAudio());
window.addEventListener('blur', pauseWorldAudio);
document.querySelector('#back').addEventListener('click', returnToIntro);
window.addEventListener('resize', () => {
  resizeTrail();
  if (reducedMotion() && !inWorld && openingAnimation) openingAnimation(performance.now());
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pauseWorldAudio();
  else resumeWorldAudio();
  scene?.setActive(inWorld && !document.hidden);
  writer?.setActive(inWorld && !document.hidden);
  cancelAnimationFrame(flightFrame);
  if (unlocked && !inWorld && !document.hidden && openingAnimation) flightFrame = requestAnimationFrame(openingAnimation);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && inWorld) returnToIntro(event);
});
motionPreference.addEventListener('change', () => {
  paused = reducedMotion();
  scene?.setReducedMotion(reducedMotion());
  scene?.setPaused(paused);
  writer?.setReducedMotion(reducedMotion());
  unlock.setReducedMotion(reducedMotion());
  if (unlocked && !inWorld) playOpening();
});
const wordmarkReady = prepareWordmark().catch(error => {
  wordmark.hidden = true;
  document.querySelector('#wordmark-fallback').classList.add('visible');
  console.error('Original drawing could not load', error);
});

const unlock = new SpinUnlock({
  audio: introAudio,
  reducedMotion: reducedMotion(),
  onUnlock: async ({ keyboard = false } = {}) => {
    await wordmarkReady;
    unlocked = true;
    openingKeyboard = keyboard;
    spinPanel.hidden = true;
    playOpening();
  },
});

function resetOpening() {
  cancelAnimationFrame(flightFrame);
  openingAnimation = undefined;
  unlocked = false;
  openingKeyboard = false;
  intro.classList.remove('ready');
  enter.hidden = true;
  enterHint.hidden = true;
  enter.disabled = true;
  enterHint.disabled = true;
  flight.style.opacity = '0';
  resizeTrail();
  spinPanel.hidden = false;
  unlock.reset();
  unlock.setActive(true);
}

resetOpening();
wordmarkReady.finally(() => {
  // Local, vendored modules keep the finished experience independent of CDNs.
  setTimeout(() => {
    if ('requestIdleCallback' in window) requestIdleCallback(ensureScene, { timeout: 1200 });
    else ensureScene();
  }, 2200);
});
