import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({channel:'chrome',headless:true});
const base=process.env.BASE_URL || 'http://127.0.0.1:8780';
const results=[];
try {
  const page=await browser.newPage();
  await page.goto(base);
  await page.locator('[data-video-id="odoriko-bilingual-karaoke"] .song-title').click();
  await page.waitForFunction(()=>document.querySelector('#player').currentTime>.4);
  await page.locator('#theater-toggle').click();
  await page.locator('#fullscreen-toggle').click();
  await page.waitForFunction(()=>document.fullscreenElement);
  await page.locator('#close-player').click();
  await page.waitForFunction(()=>!document.fullscreenElement && document.querySelector('#player-panel').hidden);
  assert.equal(await page.evaluate(()=>document.activeElement.closest('tr')?.dataset.videoId),'odoriko-bilingual-karaoke');
  assert.equal(await page.evaluate(()=>[...document.querySelectorAll('audio')].every(a=>a.paused)),true);
  results.push('Closing from full screen exits the overlay, stops audio and returns focus to the song');
  await page.close();

  const failed=await browser.newPage();
  await failed.route('**/audio/odoriko-karaoke-v1.m4a',route=>route.abort());
  await failed.goto(base);
  await failed.locator('[data-video-id="odoriko-bilingual-karaoke"] .song-title').click();
  await failed.waitForFunction(()=>{
    const v=document.querySelector('#player');return v.currentTime>.5 && v.controls && !v.muted;
  });
  const original=await failed.locator('#player').getAttribute('src');
  await failed.locator('#theater-toggle').click();
  assert.equal(await failed.locator('#player').getAttribute('src'),original);
  assert.equal(await failed.locator('#player-status').isVisible(),true);
  results.push('If the active audio fails, the same video continues with its native audio');
  await failed.close();

  await mkdir(new URL('../test-results/',import.meta.url),{recursive:true});
  await writeFile(new URL('../test-results/cinema-fallback.json',import.meta.url),JSON.stringify({status:'passed',checks:results},null,2));
  console.log(JSON.stringify({status:'passed',checks:results},null,2));
} finally {await browser.close();}
