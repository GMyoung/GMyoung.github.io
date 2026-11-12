'use strict';
const list = document.querySelector('#video-list');
const search = document.querySelector('#search');
const message = document.querySelector('#message');
const player = document.querySelector('#player');
const panel = document.querySelector('#player-panel');
const catalogScroll = document.querySelector('#catalog-scroll');
const catalogCount = document.querySelector('#catalog-count');
const cinema = window.CinemaPlayer ? new CinemaPlayer(panel) : null;
let videos = [];
let selectedFilter = 'all';
let selectedId = null;
let selectionOrigin = null;
let navigationGeneration = 0;
function findSongRow(id) { return [...list.rows].find(row => row.dataset.videoId === String(id)); }
function markSelected() {
  for (const row of list.rows) {
    const selected = row.dataset.videoId === String(selectedId);
    row.classList.toggle('is-selected', selected);
    for (const link of row.querySelectorAll('a[data-song-action="title"],a[data-song-action="play"]')) {
      if (selected) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    }
  }
}
function safeUrl(value) {
  if (!value) return null;
  try { const url = new URL(value, location.href); return url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === '127.0.0.1') ? url.href : null; }
  catch { return null; }
}
function showPlayer(video, url, autoplay = true, trigger = null) {
  navigationGeneration += 1;
  selectedId = video.id;
  selectionOrigin = { id: video.id, action: trigger?.dataset.songAction || 'title', scrollTop: catalogScroll.scrollTop };
  markSelected();
  document.querySelector('#player-title').textContent = video.title + ' · ' + (video.type === 'karaoke' ? 'Karaoke' : 'Instrumental');
  panel.hidden = false;
  if (cinema) {
    const audio = Object.fromEntries(Object.entries(video.audio || {}).map(([name,value]) => [name,safeUrl(value)]));
    cinema.open({...video,audio},url,autoplay);
  } else {
    player.src = url;
    player.poster = video.poster || '';
    player.load();
    if (autoplay) player.play().catch(() => {});
  }
  // Selecting songs is frequent: return immediately, including keyboard input.
  panel.scrollIntoView({block:'start', behavior:'auto'});
  player.focus({preventScroll:true});
}
function attachVideoLink(link, video, url) {
  link.href = url;
  if (/\.mp4(?:$|[?#])/i.test(url)) {
    link.addEventListener('click', event => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); showPlayer(video, url, true, link);
    });
  } else { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
}
function cell(row, text, className = '') {
  const element = document.createElement('td'); element.textContent = text; element.className = className; row.append(element); return element;
}
function render({resetScroll = false} = {}) {
  const scrollTop = catalogScroll.scrollTop;
  const viewportTop = catalogScroll.getBoundingClientRect().top;
  const headerHeight = catalogScroll.querySelector('thead').getBoundingClientRect().height;
  const anchor = resetScroll ? null : [...list.rows].find(row => row.getBoundingClientRect().bottom > viewportTop + headerHeight);
  const anchorId = anchor?.dataset.videoId;
  const anchorOffset = anchor ? anchor.getBoundingClientRect().top - viewportTop : 0;
  const focusedLink = list.contains(document.activeElement) ? document.activeElement.closest('a') : null;
  const focusedId = focusedLink?.closest('tr')?.dataset.videoId;
  const focusedAction = focusedLink?.dataset.songAction;
  const term = search.value.trim().toLowerCase();
  const shown = videos.filter(video => (selectedFilter === 'all' || selectedFilter === video.type || (selectedFilter === 'karaoke' && video.karaoke)) && (video.title + ' ' + video.artist + ' ' + video.label).toLowerCase().includes(term));
  list.replaceChildren();
  for (const video of shown) {
    const row = document.createElement('tr'), url = safeUrl(video.url);
    row.dataset.videoId = video.id;
    cell(row, String(videos.indexOf(video)+1).padStart(2,'0'), 'number');
    const song = cell(row, '', 'song-cell'), title = document.createElement(url ? 'a' : 'span');
    title.textContent = video.title; title.className = 'song-title';
    title.dataset.songAction = 'title';
    if (url) attachVideoLink(title, video, url);
    const note = document.createElement('div'); note.className = 'song-note'; note.textContent = video.label || video.artist; song.append(title,note);
    cell(row, video.artist, 'artist-col');
    const version = cell(row, '', 'version-col'), tag = document.createElement('span'); tag.className = 'type'; tag.textContent = video.type === 'karaoke' ? 'Karaoke' : 'Instrumental'; version.append(tag);
    const sourceUrl = safeUrl(video.instrumentalSource?.url);
    if (sourceUrl) {
      const source = document.createElement('a');
      const provider = /(^|\.)bilibili\.com$/.test(new URL(sourceUrl).hostname) ? 'Bilibili' : 'YouTube';
      const original = video.instrumentalSource.kind === 'original';
      source.className = 'song-source';
      source.dataset.songAction = 'source';
      source.href = sourceUrl;
      source.target = '_blank';
      source.rel = 'noopener noreferrer';
      source.textContent = `${provider}${original ? ' original' : ''} ↗`;
      source.title = original ? 'Original recording; accompaniment prepared locally. Opens a new tab.' : 'Original accompaniment source. Opens a new tab.';
      source.setAttribute('aria-label', `${video.title}: open ${original ? 'original recording' : 'accompaniment source'} on ${provider} in a new tab`);
      version.append(source);
    }
    cell(row, video.duration, 'duration-col');
    const action = cell(row, '', 'watch-col'), link = document.createElement(url ? 'a' : 'span');
    link.dataset.songAction = 'play';
    if (url) { attachVideoLink(link, video, url); link.textContent = /\.mp4(?:$|[?#])/i.test(url) ? 'Play' : 'Watch ↗'; link.setAttribute('aria-label','Play ' + video.title + ' ' + tag.textContent); }
    else { link.className = 'pending'; link.textContent = 'Preparing video'; }
    action.append(link); list.append(row);
  }
  message.textContent = 'No matching videos.'; message.hidden = shown.length > 0;
  catalogCount.textContent = shown.length === videos.length ? `${shown.length} songs` : `${shown.length} of ${videos.length} songs`;
  markSelected();
  if (focusedId) {
    const row = findSongRow(focusedId);
    const replacement = [...(row?.querySelectorAll('a') || [])].find(link => link.dataset.songAction === focusedAction);
    (replacement || catalogScroll).focus({preventScroll:true});
  }
  catalogScroll.scrollTop = resetScroll ? 0 : scrollTop;
  const restoredAnchor = anchorId && findSongRow(anchorId);
  if (restoredAnchor) {
    catalogScroll.scrollTop += restoredAnchor.getBoundingClientRect().top - catalogScroll.getBoundingClientRect().top - anchorOffset;
  }
}
search.addEventListener('input',() => render({resetScroll:true}));
document.querySelector('.filters').addEventListener('click',event => {
  const button = event.target.closest('[data-filter]'); if (!button) return;
  selectedFilter = button.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach(item => { item.classList.toggle('active',item === button); item.setAttribute('aria-pressed',String(item === button)); }); render({resetScroll:true});
});
document.querySelector('#close-player').addEventListener('click',async () => {
  const generation = ++navigationGeneration;
  if (cinema) await cinema.close();
  else { player.pause(); player.removeAttribute('src'); player.load(); panel.hidden = true; }
  if (generation !== navigationGeneration || !panel.hidden) return;
  const row = selectionOrigin && findSongRow(selectionOrigin.id);
  const target = row && [...row.querySelectorAll('a')].find(link => link.dataset.songAction === selectionOrigin.action);
  if (row) catalogScroll.scrollTop = selectionOrigin.scrollTop;
  catalogScroll.scrollIntoView({block:'nearest', behavior:'auto'});
  if (row) {
    const viewport = catalogScroll.getBoundingClientRect(), bounds = row.getBoundingClientRect();
    const headerHeight = catalogScroll.querySelector('thead').getBoundingClientRect().height;
    if (bounds.top < viewport.top + headerHeight) catalogScroll.scrollTop += bounds.top - viewport.top - headerHeight;
    else if (bounds.bottom > viewport.bottom) catalogScroll.scrollTop += bounds.bottom - viewport.bottom;
  }
  (target || catalogScroll).focus({preventScroll:true});
});
document.addEventListener('keydown',event => { if (event.key === '/' && !event.ctrlKey && !event.metaKey && !['INPUT','TEXTAREA'].includes(document.activeElement.tagName)) { event.preventDefault(); search.focus(); } });
function loadCatalog() {
fetch('videos.json?updated=' + Date.now(),{cache:'no-store'}).then(response => { if (!response.ok) throw new Error('Catalog unavailable'); return response.json(); }).then(catalog => {
  videos = catalog.videos; document.querySelector('#video-count').textContent = videos.length;
  if (catalog.showPlaylist) { const url = safeUrl(catalog.playlistUrl); if (url) { const link = document.querySelector('#playlist-link'); link.href = url; link.hidden = false; } }
  render();
}).catch(() => { if (!videos.length) { message.hidden = false; message.textContent = 'Unable to load videos. Please refresh the page.'; } });
}
loadCatalog();
window.addEventListener('focus', loadCatalog);
