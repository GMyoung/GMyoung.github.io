import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep public application snapshots and old hashed assets, but publish only
// the current catalog's reachable media. No network, deletion, or overwriting.
const ROOT_FILES = [
  'index.html', 'karaoke.html', 'app.js', 'player.js', 'streaming.js',
  'lyrics.js', 'fullscreen.js', 'style.css', 'portal.css', 'videos.json',
  'icon.svg', 'robots.txt', '.nojekyll'
];
const PUBLIC_DIRECTORIES = ['assets', 'audio', 'ink', 'car-game'];
const MAX_BYTES = 1_000_000_000;
const LOCAL_ORIGIN = 'https://local-stage.invalid';

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function canonicalDestination(value) {
  let current = path.resolve(value);
  const missing = [];
  while (true) {
    try {
      return path.join(await realpath(current), ...missing);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--output' || !args[1].trim()) {
    throw new Error('Usage: node scripts/stage-site.mjs --output <empty directory outside this checkout>');
  }
  const source = await realpath(fileURLToPath(new URL('../', import.meta.url)));
  const output = await canonicalDestination(args[1]);
  if (output === path.parse(output).root || output === source || inside(source, output) || inside(output, source)) {
    throw new Error(`Staging output must be outside the source checkout and cannot be a filesystem root or source ancestor: ${output}`);
  }
  try {
    if (!(await lstat(output)).isDirectory() || (await readdir(output)).length) {
      throw new Error(`Staging output must be an empty directory. Nothing was deleted or overwritten: ${output}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const checkedPaths = new Map();
  const files = new Map();
  const externalReferences = new Set();
  const visitedMedia = new Set();
  const pendingMedia = [];

  async function inspect(relative, expected) {
    const pieces = relative.split('/');
    for (let i = 0; i < pieces.length; i++) {
      const partial = pieces.slice(0, i + 1).join('/');
      let info = checkedPaths.get(partial);
      if (!info) {
        try {
          info = await lstat(path.join(source, ...pieces.slice(0, i + 1)));
        } catch (error) {
          if (error.code === 'ENOENT') throw new Error(`Missing public file or directory: ${partial}. Run the build or prepare its media before staging.`);
          throw error;
        }
        if (info.isSymbolicLink()) throw new Error(`Symlinks are not allowed in staged public paths: ${partial}`);
        checkedPaths.set(partial, info);
      }
      const directory = i < pieces.length - 1 || expected === 'directory';
      if (directory ? !info.isDirectory() : !info.isFile()) {
        throw new Error(`Expected a regular ${directory ? 'directory' : 'file'} in public output: ${partial}`);
      }
    }
    return checkedPaths.get(relative);
  }

  async function addFile(relative, reason) {
    if (files.has(relative)) return;
    try {
      const info = await inspect(relative, 'file');
      files.set(relative, { size: info.size, modified: info.mtimeMs });
    } catch (error) {
      throw new Error(`${error.message} Referenced by ${reason}.`);
    }
  }

  async function addDirectory(relative) {
    await inspect(relative, 'directory');
    const entries = await readdir(path.join(source, ...relative.split('/')), { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const child = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Symlinks are not allowed in public output: ${child}`);
      if (entry.isDirectory()) await addDirectory(child);
      else await addFile(child, `public directory ${relative}`);
    }
  }

  function mediaReference(value, base, reason) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Empty or invalid media URL in ${reason}`);
    if (/[\u0000-\u001f\u007f\\]/.test(value)) throw new Error(`Unsafe media URL in ${reason}`);
    let resolved;
    try { resolved = new URL(value, new URL(base, `${LOCAL_ORIGIN}/`)); }
    catch { throw new Error(`Invalid media URL in ${reason}: ${value}`); }
    if (resolved.origin !== LOCAL_ORIGIN) {
      if (resolved.protocol !== 'https:') throw new Error(`Only HTTPS external media may be skipped: ${reason}`);
      externalReferences.add(resolved.href);
      return null;
    }
    let decoded;
    try { decoded = decodeURIComponent(resolved.pathname); }
    catch { throw new Error(`Invalid URL encoding in ${reason}: ${value}`); }
    if (/[\u0000-\u001f\u007f\\:]/.test(decoded)) throw new Error(`Unsafe decoded media path in ${reason}`);
    const normalized = path.posix.normalize(decoded);
    if (!normalized.startsWith('/media/') || normalized.endsWith('/')) {
      throw new Error(`Local media reference leaves the public media directory: ${value} in ${reason}`);
    }
    const relative = normalized.slice(1);
    if (!inside(path.join(source, 'media'), path.join(source, ...relative.split('/')))) {
      throw new Error(`Media path escapes the public media directory: ${value} in ${reason}`);
    }
    return relative;
  }

  function enqueue(value, base, reason) {
    const relative = mediaReference(value, base, reason);
    if (relative) pendingMedia.push({ relative, reason });
  }

  for (const name of ROOT_FILES) await addFile(name, 'public root file list');
  for (const name of PUBLIC_DIRECTORIES) await addDirectory(name);
  const catalog = JSON.parse((await readFile(path.join(source, 'videos.json'), 'utf8')).replace(/^\uFEFF/, ''));
  if (!Array.isArray(catalog.videos)) throw new Error('videos.json must contain a videos array.');
  for (const [index, video] of catalog.videos.entries()) {
    const label = `videos.json entry ${video.id || index}`;
    if (video.url) enqueue(video.url, 'videos.json', `${label}.url`);
    for (const [kind, descriptor] of [['streaming', video.streaming], ['streaming.videoOnly', video.streaming?.videoOnly]]) {
      if (!descriptor) continue;
      if (descriptor.url) enqueue(descriptor.url, 'videos.json', `${label}.${kind}.url`);
      if (descriptor.variants !== undefined && !Array.isArray(descriptor.variants)) {
        throw new Error(`${label}.${kind}.variants must be an array.`);
      }
      for (const [variantIndex, variant] of (descriptor.variants || []).entries()) {
        enqueue(variant.url, 'videos.json', `${label}.${kind}.variants[${variantIndex}]`);
      }
    }
  }

  for (let i = 0; i < pendingMedia.length; i++) {
    const { relative, reason } = pendingMedia[i];
    if (visitedMedia.has(relative)) continue;
    visitedMedia.add(relative);
    await addFile(relative, reason);
    if (!/\.m3u8?$/i.test(relative)) continue;
    const text = (await readFile(path.join(source, ...relative.split('/')), 'utf8')).replace(/^\uFEFF/, '');
    if (!text.trimStart().startsWith('#EXTM3U')) throw new Error(`Invalid HLS playlist: ${relative}`);
    for (const [lineIndex, raw] of text.split(/\r?\n/).entries()) {
      const line = raw.trim();
      if (!line) continue;
      const location = `${relative}:${lineIndex + 1}`;
      if (line.startsWith('#')) {
        // Includes URI, SERVER-URI and related URI-valued HLS attributes.
        const separator = line.indexOf(':');
        if (separator < 0) continue;
        const attributes = /(?:^|,)\s*([A-Z0-9-]+)\s*=\s*(?:"([^"]*)"|([^,]*))\s*(?=,|$)/gi;
        for (const match of line.slice(separator + 1).matchAll(attributes)) {
          if (match[1].toUpperCase() === 'URI' || match[1].toUpperCase().endsWith('-URI')) {
            enqueue(match[2] ?? match[3].trim(), relative, location);
          }
        }
      } else enqueue(line, relative, location);
    }
  }

  const totalBytes = [...files.values()].reduce((total, file) => total + file.size, 0);
  if (totalBytes >= MAX_BYTES) {
    throw new Error(`Current public site is ${totalBytes.toLocaleString('en-US')} bytes; it must be below ${MAX_BYTES.toLocaleString('en-US')} bytes (1 GB). Reduce active media before uploading. Nothing was staged.`);
  }
  await mkdir(output, { recursive: true });
  let stagedBytes = 0;
  for (const [relative, planned] of files) {
    const from = path.join(source, ...relative.split('/'));
    const to = path.join(output, ...relative.split('/'));
    const current = await lstat(from);
    if (!current.isFile() || current.size !== planned.size || current.mtimeMs !== planned.modified) {
      throw new Error(`Source changed while staging: ${relative}. Use a new empty output directory and run again.`);
    }
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to, constants.COPYFILE_EXCL);
    const copied = await lstat(to);
    if (copied.size !== planned.size) throw new Error(`Copy size changed for ${relative}; do not upload this partial staging directory.`);
    stagedBytes += copied.size;
  }
  if (stagedBytes >= MAX_BYTES) throw new Error('Staged site exceeds 1 GB; do not upload this directory.');
  console.log(JSON.stringify({
    output, files: files.size, mediaFiles: visitedMedia.size,
    bytes: stagedBytes, limitBytes: MAX_BYTES, externalMediaSkipped: externalReferences.size
  }, null, 2));
}

main().catch(error => {
  console.error(`Site staging failed: ${error.message}`);
  process.exitCode = 1;
});
