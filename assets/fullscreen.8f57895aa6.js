'use strict';

// Full-page fullscreen keeps the picture and vocal mix controls together.
window.initCinemaFullscreen = function initCinemaFullscreen(player) {
  const root = player.root;
  const video = player.video;
  const button = player.fullscreenButton;
  const shell = root.querySelector('.player-shell');
  let bottom = shell.querySelector('.player-bottom');
  if (!bottom) {
    bottom = document.createElement('div');
    bottom.className = 'player-bottom';
    const controls = [...shell.children].filter(element =>
      element.matches('.soundtracks,.transport,.streaming-tools,.player-status'));
    if (controls.length) {
      controls[0].before(bottom);
      bottom.append(...controls);
    }
  }

  let idleTimer;
  let keyboardInput = false;
  let mouseInput = false;
  let dragging = false;
  let nativeVideoFullscreen = false;
  let wasActive = false;
  let returnFocus;
  let revealTouch = false;
  const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement;
  const isRootFullscreen = () => fullscreenElement() === root;
  const isActive = () => isRootFullscreen() || fullscreenElement() === video || nativeVideoFullscreen;
  const controlHasFocus = () => keyboardInput && root.contains(document.activeElement) &&
    document.activeElement.matches('button,input,select,a,[role="button"]');
  // External captions sit above the visible transport, then return to the
  // bottom of the picture when the fullscreen controls fade out.
  const measureControls = () => root.style.setProperty('--player-controls-height', `${Math.ceil(bottom.getBoundingClientRect().height)}px`);
  if (window.ResizeObserver) new ResizeObserver(measureControls).observe(bottom);
  window.addEventListener('resize', measureControls);

  function showControls(event) {
    if (event?.pointerType) mouseInput = event.pointerType === 'mouse';
    root.classList.remove('fullscreen-idle');
    clearTimeout(idleTimer);
    if (!isRootFullscreen() || video.paused || video.ended) return;
    idleTimer = setTimeout(() => {
      if (!isRootFullscreen() || video.paused || video.ended || video.seeking ||
          video.readyState < 3 || dragging || controlHasFocus() ||
          (mouseInput && (bottom.matches(':hover') || root.querySelector('.player-heading')?.matches(':hover')))) return;
      root.classList.add('fullscreen-idle');
    }, 3000);
  }

  function updateFullscreen() {
    const active = isActive();
    root.classList.toggle('fullscreen-active', isRootFullscreen());
    measureControls();
    document.body.classList.toggle('fullscreen-open', active);
    button.textContent = active ? 'Exit full screen' : 'Full screen';
    button.setAttribute('aria-pressed', String(active));
    if (active && !wasActive) {
      returnFocus = document.activeElement;
      if (isRootFullscreen()) {
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'true');
        if (!keyboardInput) video.focus({ preventScroll: true });
      }
    } else if (!active && wasActive) {
      root.removeAttribute('role');
      root.removeAttribute('aria-modal');
      if (!root.hidden && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    }
    wasActive = active;
    showControls();
  }

  async function close() {
    try {
      if (fullscreenElement() === root || fullscreenElement() === video) {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) await exit.call(document);
      } else if (nativeVideoFullscreen && video.webkitExitFullscreen) {
        video.webkitExitFullscreen();
      }
    } catch { /* Closing the player must still work when the browser exits first. */ }
  }

  async function toggle() {
    if (isActive()) { await close(); return; }
    try {
      if (root.requestFullscreen) await root.requestFullscreen({ navigationUI: 'hide' });
      else if (root.webkitRequestFullscreen) root.webkitRequestFullscreen();
      else {
        player.message('This browser cannot keep vocal mixing available in full screen. Use a browser that supports full-page fullscreen.');
      }
    } catch {
      player.message('The browser could not enter full screen. Try the Full screen button again, or use a browser that supports full-page fullscreen.');
    }
  }

  button.addEventListener('click', toggle);
  document.addEventListener('fullscreenchange', updateFullscreen);
  document.addEventListener('webkitfullscreenchange', updateFullscreen);
  video.addEventListener('webkitbeginfullscreen', () => { nativeVideoFullscreen = true; updateFullscreen(); });
  video.addEventListener('webkitendfullscreen', () => { nativeVideoFullscreen = false; updateFullscreen(); });
  root.addEventListener('pointermove', showControls);
  root.addEventListener('pointerdown', event => {
    revealTouch = isRootFullscreen() && root.classList.contains('fullscreen-idle') &&
      event.pointerType === 'touch' && event.target === video;
    keyboardInput = false;
    mouseInput = event.pointerType === 'mouse';
    dragging = true;
    showControls();
  });
  document.addEventListener('pointerup', () => { dragging = false; if (isRootFullscreen()) showControls(); });
  document.addEventListener('pointercancel', () => { dragging = false; revealTouch = false; if (isRootFullscreen()) showControls(); });
  root.addEventListener('click', event => {
    if (revealTouch && event.target === video) {
      revealTouch = false;
      event.preventDefault();
      event.stopImmediatePropagation();
      showControls();
    }
  }, true);
  root.addEventListener('focusin', showControls);
  root.addEventListener('focusout', () => { if (isRootFullscreen()) showControls(); });
  bottom.addEventListener('pointerleave', showControls);
  root.querySelector('.player-heading')?.addEventListener('pointerleave', showControls);
  for (const name of ['play', 'playing', 'pause', 'waiting', 'seeking', 'seeked', 'ended']) {
    video.addEventListener(name, showControls);
  }
  new MutationObserver(showControls).observe(player.status, { childList: true, characterData: true, subtree: true });
  document.addEventListener('keydown', event => {
    keyboardInput = true;
    if (!isRootFullscreen()) return;
    showControls();
    if (event.key !== 'Tab') return;
    const focusable = [...root.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]')]
      .filter(element => element.getClientRects().length);
    const first = focusable[0], last = focusable.at(-1);
    if (!first) return;
    if (event.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) {
      event.preventDefault(); first.focus();
    }
  }, true);

  player.fullscreen = { toggle, close, isActive, showControls };
  return player.fullscreen;
};
