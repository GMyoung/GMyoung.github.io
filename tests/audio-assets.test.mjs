import assert from 'node:assert/strict';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const catalog=JSON.parse(await readFile(path.join(root,'videos.json'),'utf8'));
const cache=new Map();
function duration(file) {
  if(!cache.has(file)) cache.set(file,Number(JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','format=duration','-of','json',path.join(root,file)],{encoding:'utf8'})).format.duration));
  return cache.get(file);
}
const checks=[];
for(const entry of catalog.videos) {
  const expected=duration(entry.url);
  assert(entry.audio?.original && entry.audio?.karaoke,`${entry.id} requires both audio tracks`);
  const hashes=[];
  for(const type of ['original','karaoke']) {
    const file=entry.audio[type];
    assert(Math.abs(duration(file)-expected)<.15,`${entry.id} ${type} timeline length`);
    hashes.push(createHash('sha256').update(await readFile(path.join(root,file))).digest('hex'));
  }
  assert.notEqual(hashes[0],hashes[1],`${entry.id} soundtracks must be distinct`);
  checks.push(`${entry.id}: both distinct tracks match the video duration`);
}
await mkdir(path.join(root,'test-results'),{recursive:true});
await writeFile(path.join(root,'test-results','audio-assets.json'),JSON.stringify({status:'passed',checks},null,2));
console.log(JSON.stringify({status:'passed',checks},null,2));
