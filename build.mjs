import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = new URL('./', import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 10);
// Windows checkout conversion must not change published content hashes.
const readText = async path => (await readFile(new URL(path, root), 'utf8')).replace(/\r\n?/g, '\n');
await mkdir(new URL('assets/', root), { recursive: true });
const catalog = await readText('videos.json');
JSON.parse(catalog);
const catalogPath = `assets/catalog.${hash(catalog)}.json`;
await writeFile(new URL(catalogPath, root), catalog);
let script = await readText('app.js');
const scriptPath = `assets/app.${hash(script)}.js`;
await writeFile(new URL(scriptPath, root), script);
const player = await readText('player.js');
const playerPath = `assets/player.${hash(player)}.js`;
await writeFile(new URL(playerPath, root), player);
const extraScripts = {};
for (const name of ['streaming', 'lyrics', 'fullscreen']) {
  const content = await readText(`${name}.js`);
  const path = `assets/${name}.${hash(content)}.js`;
  await writeFile(new URL(path, root), content);
  extraScripts[name] = path;
}
const styles = await readText('style.css');
const stylesPath = `assets/style.${hash(styles)}.css`;
await writeFile(new URL(stylesPath, root), styles);
let karaoke = await readText('karaoke.template.html');
karaoke = karaoke.replace('href="style.css"', `href="${stylesPath}"`).replace('src="player.js"', `src="${playerPath}"`).replace('src="app.js"', `src="${scriptPath}"`);
for (const [name, path] of Object.entries(extraScripts)) karaoke = karaoke.replace(`src="${name}.js"`, `src="${path}"`);
await writeFile(new URL('karaoke.html', root), karaoke);
const portalStyles = await readText('portal.css');
const portalStylesPath = `assets/portal.${hash(portalStyles)}.css`;
await writeFile(new URL(portalStylesPath, root), portalStyles);
const portal = (await readText('index.template.html'))
  .replace('href="portal.css"', `href="${portalStylesPath}"`);
await writeFile(new URL('index.html', root), portal);
console.log(JSON.stringify({ pages: ['index.html', 'karaoke.html'], portalStylesPath, scriptPath, playerPath, stylesPath, catalogPath }));
