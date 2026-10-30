'use strict';
const list = document.querySelector('#video-list');
const search = document.querySelector('#search');
const message = document.querySelector('#message');
const player = document.querySelector('#player');
const panel = document.querySelector('#player-panel');
let videos = [];
let selectedFilter = 'all';
function safeUrl(value) {
  if (!value) return null;
  try { const url = new URL(value, location.href); return url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === '127.0.0.1') ? url.href : null; }
  catch { return null; }
}
function showPlayer(video, url, autoplay = true) {
  document.querySelector('#player-title').textContent = video.title + ' · ' + (video.type === 'karaoke' ? 'Karaoke' : 'Instrumental');
  player.src = url;
  player.poster = video.poster || '';
  panel.hidden = false;
  player.load();
  if (autoplay) player.play().catch(() => {});
  panel.scrollIntoView({block:'nearest'});
}
function attachVideoLink(link, video, url) {
  link.href = url;
  if (/\.mp4(?:$|[?#])/i.test(url)) {
    link.addEventListener('click', event => { event.preventDefault(); showPlayer(video, url); });
  } else { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
}
function cell(row, text, className = '') {
  const element = document.createElement('td'); element.textContent = text; element.className = className; row.append(element); return element;
}
function render() {
  const term = search.value.trim().toLowerCase();
  const shown = videos.filter(video => (selectedFilter === 'all' || selectedFilter === video.type || (selectedFilter === 'karaoke' && video.karaoke)) && (video.title + ' ' + video.artist + ' ' + video.label).toLowerCase().includes(term));
  list.replaceChildren();
  for (const video of shown) {
    const row = document.createElement('tr'), url = safeUrl(video.url);
    cell(row, String(videos.indexOf(video)+1).padStart(2,'0'), 'number');
    const song = cell(row, ''), title = document.createElement(url ? 'a' : 'span');
    title.textContent = video.title; title.className = 'song-title';
    if (url) attachVideoLink(title, video, url);
    const note = document.createElement('div'); note.className = 'song-note'; note.textContent = video.label || video.artist; song.append(title,note);
    cell(row, video.artist, 'artist-col');
    const version = cell(row, ''), tag = document.createElement('span'); tag.className = 'type'; tag.textContent = video.type === 'karaoke' ? 'Karaoke' : 'Instrumental'; version.append(tag);
    cell(row, video.duration, 'duration-col');
    const action = cell(row, '', 'watch-col'), link = document.createElement(url ? 'a' : 'span');
    if (url) { attachVideoLink(link, video, url); link.textContent = 'Play ↗'; link.setAttribute('aria-label','Play ' + video.title + ' ' + tag.textContent); }
    else { link.className = 'pending'; link.textContent = 'Preparing video'; }
    action.append(link); list.append(row);
  }
  message.textContent = 'No matching videos.'; message.hidden = shown.length > 0;
}
search.addEventListener('input',render);
document.querySelector('.filters').addEventListener('click',event => {
  const button = event.target.closest('[data-filter]'); if (!button) return;
  selectedFilter = button.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach(item => { item.classList.toggle('active',item === button); item.setAttribute('aria-pressed',String(item === button)); }); render();
});
document.querySelector('#close-player').addEventListener('click',() => { player.pause(); player.removeAttribute('src'); player.load(); panel.hidden = true; });
document.addEventListener('keydown',event => { if (event.key === '/' && !event.ctrlKey && !event.metaKey && !['INPUT','TEXTAREA'].includes(document.activeElement.tagName)) { event.preventDefault(); search.focus(); } });
fetch('videos.json',{cache:'no-cache'}).then(response => { if (!response.ok) throw new Error('Catalog unavailable'); return response.json(); }).then(catalog => {
  videos = catalog.videos; document.querySelector('#video-count').textContent = videos.length;
  if (catalog.showPlaylist) { const url = safeUrl(catalog.playlistUrl); if (url) { const link = document.querySelector('#playlist-link'); link.href = url; link.hidden = false; } }
  render();
}).catch(() => { message.textContent = 'Unable to load videos. Please refresh the page.'; });
