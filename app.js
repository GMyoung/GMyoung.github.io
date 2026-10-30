'use strict';
const grid = document.querySelector('#video-grid');
const template = document.querySelector('#video-template');
const search = document.querySelector('#search');
const message = document.querySelector('#load-message');
let videos = [];
let selectedFilter = 'all';
const safeUrl = value => {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['www.youtube.com', 'youtube.com', 'youtu.be'].includes(url.hostname) ? url.href : null;
  } catch { return null; }
};
function render() {
  const term = search.value.trim().toLocaleLowerCase();
  const visible = videos.filter(video => (selectedFilter === 'all' || video.type === selectedFilter) && [video.title, video.artist, video.label].join(' ').toLocaleLowerCase().includes(term));
  grid.replaceChildren();
  for (const video of visible) {
    const node = template.content.cloneNode(true);
    const card = node.querySelector('.video-card');
    const url = safeUrl(video.url);
    const artwork = node.querySelector('.artwork');
    const watch = node.querySelector('.watch');
    node.querySelector('h3').textContent = video.title;
    node.querySelector('.artist').textContent = video.artist;
    node.querySelector('.duration').textContent = video.duration;
    node.querySelector('.type-label').textContent = video.type === 'karaoke' ? 'KARAOKE' : 'INSTRUMENTAL';
    node.querySelector('.version-label').textContent = video.label || '纯伴奏影像';
    node.querySelector('.card-index').textContent = String(videos.indexOf(video) + 1).padStart(2, '0');
    const image = node.querySelector('img');
    image.src = video.poster;
    image.alt = `${video.title} 视频封面`;
    if (url) {
      artwork.href = url;
      artwork.setAttribute('aria-label', `在 YouTube 播放 ${video.title} ${video.type}`);
      watch.href = url;
      watch.setAttribute('aria-label', `播放 ${video.title} ${video.type}`);
    } else {
      card.classList.add('is-pending');
      artwork.removeAttribute('target');
      watch.hidden = true;
      node.querySelector('.pending').hidden = false;
    }
    grid.append(node);
  }
  document.querySelector('#empty').hidden = visible.length > 0;
}
search.addEventListener('input', render);
document.querySelector('#filters').addEventListener('click', event => {
  const button = event.target.closest('[data-filter]');
  if (!button) return;
  selectedFilter = button.dataset.filter;
  for (const filter of document.querySelectorAll('[data-filter]')) {
    const active = filter === button;
    filter.classList.toggle('active', active);
    filter.setAttribute('aria-pressed', String(active));
  }
  render();
});
document.addEventListener('keydown', event => {
  if (event.key === '/' && !event.metaKey && !event.ctrlKey && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
    event.preventDefault();
    search.focus();
  }
});
document.querySelector('#copy-link').addEventListener('click', async event => {
  const button = event.currentTarget;
  try {
    await navigator.clipboard.writeText(new URL('./', location.href).href);
    button.textContent = '链接已复制 ✓';
    setTimeout(() => { button.innerHTML = '分享片库 <span aria-hidden="true">↗</span>'; }, 1800);
  } catch {
    button.textContent = '复制浏览器地址即可';
  }
});
fetch('videos.json', { cache: 'no-cache' }).then(response => {
  if (!response.ok) throw new Error('Catalog unavailable');
  return response.json();
}).then(catalog => {
  videos = catalog.videos;
  document.querySelector('#video-count').textContent = String(videos.length).padStart(2, '0');
  const playlist = safeUrl(catalog.playlistUrl);
  if (playlist) {
    const link = document.querySelector('#playlist-link');
    link.href = playlist;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.hidden = false;
  }
  message.hidden = true;
  render();
}).catch(() => {
  message.textContent = '片库暂时没有载入，请刷新页面。';
});
