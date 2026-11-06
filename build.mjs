import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = new URL('./', import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 10);
await mkdir(new URL('assets/', root), { recursive: true });
const catalog = await readFile(new URL('videos.json', root), 'utf8');
JSON.parse(catalog);
const catalogPath = `assets/catalog.${hash(catalog)}.json`;
await writeFile(new URL(catalogPath, root), catalog);
let script = await readFile(new URL('app.js', root), 'utf8');
const scriptPath = `assets/app.${hash(script)}.js`;
await writeFile(new URL(scriptPath, root), script);
const player = await readFile(new URL('player.js', root), 'utf8');
const playerPath = `assets/player.${hash(player)}.js`;
await writeFile(new URL(playerPath, root), player);
const styles = await readFile(new URL('style.css', root), 'utf8');
const stylesPath = `assets/style.${hash(styles)}.css`;
await writeFile(new URL(stylesPath, root), styles);
let karaoke = await readFile(new URL('karaoke.template.html', root), 'utf8');
karaoke = karaoke.replace('href="style.css"', `href="${stylesPath}"`).replace('src="player.js"', `src="${playerPath}"`).replace('src="app.js"', `src="${scriptPath}"`);
await writeFile(new URL('karaoke.html', root), karaoke);
const portalStyles = await readFile(new URL('portal.css', root), 'utf8');
const portalStylesPath = `assets/portal.${hash(portalStyles)}.css`;
await writeFile(new URL(portalStylesPath, root), portalStyles);
const portal = (await readFile(new URL('index.template.html', root), 'utf8'))
  .replace('href="portal.css"', `href="${portalStylesPath}"`);
await writeFile(new URL('index.html', root), portal);
console.log(JSON.stringify({ pages: ['index.html', 'karaoke.html'], portalStylesPath, scriptPath, playerPath, stylesPath, catalogPath }));
