import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const base = process.env.BASE_URL || 'http://127.0.0.1:8780';
const output = new URL('../test-results/', import.meta.url);
await mkdir(output, {recursive:true});
const results = [];
const browser = await chromium.launch({channel:'chrome', headless:true});
let page;
const wait = (target, fn, message, arg) => target.waitForFunction(fn, arg, {timeout:15000}).catch(error => { throw new Error(`${message}: ${error.message}`); });
const state = target => target.evaluate(() => {
  const v = document.querySelector('#player');
  return {src:v.currentSrc, time:v.currentTime, paused:v.paused, controls:v.controls, muted:v.muted,
    active:document.querySelector('#audio-toggle')?.dataset.currentAudio,
    audio:Object.fromEntries(['original','karaoke'].map(name => {
      const a = document.querySelector(`#audio-${name}`);
      return [name,{time:a.currentTime,paused:a.paused,volume:a.volume,rate:a.playbackRate,error:a.error?.code||0}];
    })), events:window.__mediaEvents||[], frames:window.__frameCount||0};
});
async function openSong(target, id) {
  await target.locator(`[data-video-id="${id}"] .song-title`).click();
  await wait(target, () => document.querySelector('#player').currentTime > .4 && !document.querySelector('#player').paused, `Playback starts for ${id}`);
  await wait(target, () => ['original','karaoke'].every(n => document.querySelector(`#audio-${n}`).readyState >= 2), `Both soundtracks load for ${id}`);
}
async function select(target, name) {
  const button=target.locator('#audio-toggle');
  if(await button.getAttribute('data-current-audio')!==name || await button.getAttribute('aria-busy')==='true') await button.click();
  await wait(target, n => document.querySelector('#audio-toggle').dataset.currentAudio === n && document.querySelector('#audio-toggle').getAttribute('aria-busy') === 'false', `Select ${name}`, name);
  await target.waitForTimeout(150);
}
try {
  page = await browser.newPage({viewport:{width:1280,height:900}});
  const errors=[];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await wait(page, () => document.querySelectorAll('#video-list tr').length === 8, 'Eight existing videos remain available');
  await openSong(page,'odoriko-bilingual-karaoke');
  await page.locator('#theater-toggle').click();
  assert.equal(await page.locator('#player-panel').getAttribute('role'),'dialog');
  assert.equal(await page.locator('#player-panel').getAttribute('aria-modal'),'true');
  for (const height of [900,720]) {
    await page.setViewportSize({width:1280,height});
    const controls=await page.locator('.soundtracks').boundingBox();
    assert(controls.y>=0 && controls.y+controls.height<=height,'Desktop soundtrack buttons stay visible');
  }
  await page.setViewportSize({width:1280,height:900});
  await page.locator('#theater-toggle').focus();
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'fullscreen-toggle');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'theater-toggle');
  await page.evaluate(() => {
    const v=document.querySelector('#player');
    window.__sameVideo=v; window.__mediaEvents=[]; window.__frameCount=0;
    for (const event of ['loadstart','emptied']) v.addEventListener(event,()=>window.__mediaEvents.push(event));
    const frame=()=>{window.__frameCount++;v.requestVideoFrameCallback(frame);};
    v.requestVideoFrameCallback(frame);
  });
  const before=await state(page);
  await select(page,'original');
  await page.waitForTimeout(700);
  await select(page,'karaoke');
  await page.waitForTimeout(700);
  let after=await state(page);
  assert.equal(await page.evaluate(()=>window.__sameVideo===document.querySelector('#player')),true);
  assert.equal(after.src,before.src,'Switching audio must retain the video URL');
  assert.deepEqual(after.events,[],'Switching must not empty or reload the video');
  assert(after.time > before.time+1,'Video time continues while audio changes');
  assert(after.frames > before.frames+15,'Decoded video frames continue');
  assert(after.audio.karaoke.volume>.8 && after.audio.original.volume===0,'Only karaoke is audible');
  assert(Math.abs(after.audio.karaoke.time-after.time)<.2,'Audio stays synchronized');
  results.push('Playing switches keep the same video element, source and continuous decoded frames');

  for (let i=0;i<8;i++) await page.locator('#audio-toggle').click();
  await wait(page,()=>document.querySelector('#audio-toggle').dataset.currentAudio==='karaoke','Latest rapid switch wins');
  await page.waitForTimeout(200);
  assert.equal((await state(page)).audio.original.volume,0);
  results.push('Rapid switching resolves to the latest selection');

  await page.locator('#play-pause').click();
  await wait(page,()=>document.querySelector('#player').paused,'Pause');
  const paused=await state(page);
  await select(page,'original');
  after=await state(page);
  assert(after.paused && after.audio.original.paused && after.audio.karaoke.paused);
  assert(Math.abs(after.time-paused.time)<.03,'Paused switch retains position');
  await page.locator('#seek').evaluate(el=>{el.value='90';el.dispatchEvent(new Event('input',{bubbles:true}));});
  await wait(page,()=>Math.abs(document.querySelector('#player').currentTime-90)<.2,'Seek while paused');
  await page.locator('#play-pause').click();
  await wait(page,()=>document.querySelector('#player').currentTime>90.5,'Resume after seek');
  await select(page,'karaoke');
  after=await state(page);
  assert(Math.abs(after.audio.karaoke.time-after.time)<.2,'Seek propagates to soundtracks');
  results.push('Pause, seek, resumed playback and paused switching preserve synchronization');

  await page.locator('#volume').evaluate(el=>{el.value='.5';el.dispatchEvent(new Event('input',{bubbles:true}));});
  assert.equal((await state(page)).audio.karaoke.volume,.5);
  await page.locator('#mute').click();
  assert.equal((await state(page)).audio.karaoke.volume,0);
  await page.locator('#mute').click();
  await page.locator('#playback-rate').selectOption('1.25');
  await page.waitForTimeout(350);
  after=await state(page);
  assert(Math.abs(after.audio.karaoke.rate-1.25)<.04);
  results.push('Volume, mute and playback speed apply to the selected audio');

  await page.locator('#fullscreen-toggle').click();
  await wait(page,()=>document.fullscreenElement?.id==='player-panel','Full screen enters');
  await page.locator('#fullscreen-toggle').click();
  await wait(page,()=>!document.fullscreenElement,'Full screen exits');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#player-panel').getAttribute('aria-modal'),null);
  assert.equal(await page.evaluate(()=>document.activeElement.id),'theater-toggle');
  assert.equal((await state(page)).paused,false,'Exiting theater keeps playback running');
  results.push('Fullscreen and Escape exit restore focus without interrupting playback');

  await page.locator('#theater-toggle').click();
  await page.screenshot({path:new URL('cinema-desktop.png',output).pathname.replace(/^\/(\w:)/,'$1')});
  await page.locator('#close-player').click();
  assert.equal(await page.locator('#player-panel').isVisible(),false);
  assert((await state(page)).audio.original.paused && (await state(page)).audio.karaoke.paused);
  assert.equal(await page.evaluate(()=>document.body.classList.contains('cinema-open')),false);

  const catalog=JSON.parse(await readFile(new URL('../videos.json',import.meta.url),'utf8'));
  for (const entry of process.argv.includes('--core-only') ? [] : catalog.videos) {
    await openSong(page,entry.id);
    await select(page,'original');
    await select(page,'karaoke');
    const current=await state(page);
    assert.equal(current.audio.karaoke.error,0,entry.id);
    assert.equal(current.audio.original.error,0,entry.id);
    assert(Math.abs(current.audio.karaoke.time-current.time)<.25,entry.id);
    await page.locator('#close-player').click();
  }
  if (!process.argv.includes('--core-only')) results.push('Every catalog entry plays and supports both audio versions');

  await openSong(page,'odoriko-bilingual-karaoke');
  await page.locator('#seek').evaluate(el=>{el.value=String(Number(el.max)-.65);el.dispatchEvent(new Event('input',{bubbles:true}));});
  await wait(page,()=>document.querySelector('#player').ended,'Playback reaches the end');
  const ended=await state(page);
  assert(ended.audio.original.paused && ended.audio.karaoke.paused,'Ending stops both soundtracks');
  await page.locator('#close-player').click();
  results.push('End of video stops both soundtracks');

  const mobile=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await mobile.goto(base);
  await wait(mobile,()=>document.querySelectorAll('#video-list tr').length===8,'Mobile catalog');
  await openSong(mobile,'shes-a-big-boy-karaoke');
  assert.equal(await mobile.locator('.soundtracks button').count(),1,'One audio button on mobile');
  const mobileBefore=await state(mobile);
  await mobile.evaluate(()=>{window.__mobileVideo=document.querySelector('#player');window.__mobileLoads=0;window.__mobileVideo.addEventListener('loadstart',()=>window.__mobileLoads++);});
  await select(mobile,'original');
  await select(mobile,'karaoke');
  await mobile.waitForTimeout(300);
  const mobileAfter=await state(mobile);
  assert(mobileAfter.time>mobileBefore.time && mobileAfter.src===mobileBefore.src);
  assert.equal(await mobile.evaluate(()=>window.__mobileVideo===document.querySelector('#player')&&window.__mobileLoads===0),true,'Mobile toggle does not replace or reload video');
  const inlineButton=await mobile.locator('#audio-toggle').boundingBox();
  const inlineVideo=await mobile.locator('#player').boundingBox();
  assert(inlineButton.y>=inlineVideo.y+inlineVideo.height-1 && inlineButton.y-inlineVideo.y-inlineVideo.height<30,'Toggle sits directly below the picture');
  await mobile.locator('#theater-toggle').click();
  await select(mobile,'original');
  for(const size of [{width:390,height:844},{width:844,height:390},{width:320,height:568}]) {
    await mobile.setViewportSize(size);
    assert.equal(await mobile.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'No horizontal overflow');
    const box=await mobile.locator('#audio-toggle').boundingBox();
    assert(box.y>=0 && box.y+box.height<=size.height && box.height>=48,'Mobile toggle remains visible and touch sized');
  }
  await mobile.setViewportSize({width:390,height:844});
  await mobile.screenshot({path:new URL('cinema-mobile.png',output).pathname.replace(/^\/(\w:)/,'$1')});
  await mobile.close();
  results.push('One mobile button switches audio without reloading video, inline and in portrait/landscape theater');

  const failure=await browser.newPage();
  await failure.route('**/audio/odoriko-original-v1.m4a',route=>route.abort());
  await failure.goto(base);
  await wait(failure,()=>document.querySelectorAll('#video-list tr').length===8,'Failure-case catalog');
  await failure.locator('[data-video-id="odoriko-bilingual-karaoke"] .song-title').click();
  await wait(failure,()=>document.querySelector('#player').currentTime>.5,'Playback with missing inactive audio');
  const failureBefore=await state(failure);
  await failure.locator('#audio-toggle').click();
  await wait(failure,()=>document.querySelector('#audio-toggle').disabled,'Unavailable audio is disabled');
  await failure.waitForTimeout(700);
  const failureAfter=await state(failure);
  assert.equal(failureAfter.active,'karaoke');
  assert(failureAfter.time>failureBefore.time && !failureAfter.paused);
  await failure.close();
  results.push('Unavailable alternate audio leaves current playback running');

  const legacy=await browser.newPage();
  const old=structuredClone(catalog);old.videos.forEach(v=>{delete v.audio;delete v.defaultAudio;});
  await legacy.route('**/videos.json?*',route=>route.fulfill({json:old}));
  await legacy.goto(base);
  await wait(legacy,()=>document.querySelectorAll('#video-list tr').length===8,'Legacy catalog loads');
  await legacy.locator('[data-video-id="odoriko-bilingual-karaoke"] .song-title').click();
  await wait(legacy,()=>document.querySelector('#player').currentTime>.5,'Legacy native playback');
  const legacyState=await state(legacy);
  assert(legacyState.controls && !legacyState.muted,'Old catalogs retain the original native player');
  await legacy.close();
  results.push('Cached old catalogs retain a working native video player');
  assert.deepEqual(errors,[],'No uncaught page errors');
  await writeFile(new URL('cinema-player.json',output),JSON.stringify({status:'passed',checks:results,base},null,2));
  console.log(JSON.stringify({status:'passed',checks:results},null,2));
} catch(error) {
  await writeFile(new URL('cinema-player.json',output),JSON.stringify({status:'failed',checks:results,error:String(error),stack:error.stack},null,2));
  if(page) await page.screenshot({path:new URL('failure.png',output).pathname.replace(/^\/(\w:)/,'$1')}).catch(()=>{});
  throw error;
} finally {await browser.close();}
