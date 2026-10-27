// Real Quarto/reveal.js geometry regression for issue #4. Prepare core fixtures.
import assert from 'node:assert/strict';
import {chromium} from './playwright.mjs';
const index = process.argv.indexOf('--port');
const port = index < 0 ? '8203' : process.argv[index + 1];
const browser = await chromium.launch();
const close = (actual, expected, message) => assert(Math.abs(actual - expected) < 1.25,
  `${message}: expected ${expected}, got ${actual}`);
try {
  for (const viewport of [{width:1280,height:800}, {width:1000,height:700}]) {
    const page = await browser.newPage({viewport,reducedMotion:'reduce'});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://localhost:${port}/dev/core-tests/slides.html`);
    await page.waitForFunction(() => window.QuartoOS && window.Reveal?.isReady());
    await page.evaluate(() => { Reveal.configure({transition:'none'}); Reveal.slide(1); });
    const inline = page.locator('section.present .qos-window.qos-inline').first();
    await inline.waitFor();
    assert.equal(await inline.evaluate(el => getComputedStyle(el).marginTop),'16px');
    console.log(`PASS inline slide spacing at viewport ${viewport.width}`);

    for (const host of ['slide', 'desktop']) {
      const id = await page.evaluate(async host => {
        Reveal.slide(host === 'desktop' ? 4 : 1);
        const slide = Reveal.getCurrentSlide();
        const target = host === 'desktop' ? slide.querySelector('.qos-desktop') : slide;
        return (await QuartoOS.open('content', {
          target, content:'Drag regression', x:130, y:120, width:320, height:220,
        })).id;
      },host);
      const win = page.locator(`[id="${id}"]`);
      async function drag(dx, dy) {
        const before = await win.boundingBox();
        const title = await win.locator('.qos-titlebar').boundingBox();
        const x = title.x + title.width/2, y = title.y + title.height/2;
        await page.mouse.move(x,y);
        await page.mouse.down();
        await page.mouse.move(x+dx,y+dy,{steps:4});
        await page.mouse.up();
        const after = await win.boundingBox();
        close(after.x-before.x,dx,'Drag horizontal movement');
        close(after.y-before.y,dy,'Drag vertical movement (no initial jump)');
      }
      await drag(1,1);
      await drag(32,45);
      await drag(-20,-25);
      assert.equal(await win.evaluate(el => getComputedStyle(el).marginTop),'0px');
      console.log(`PASS ${host} windows drag without an initial or repeated jump at viewport ${viewport.width}`);

      const before = await win.boundingBox();
      const edge = await win.locator('.qos-rs-n').boundingBox();
      const x = edge.x+edge.width/2, y = edge.y+edge.height/2;
      await page.mouse.move(x,y);
      await page.mouse.down();
      await page.mouse.move(x,y+24,{steps:4});
      await page.mouse.up();
      const after = await win.boundingBox();
      close(after.y-before.y,24,'North resize movement');
      close(after.y+after.height,before.y+before.height,'North resize keeps the bottom edge fixed');
      console.log(`PASS ${host} north-edge resize follows the pointer at viewport ${viewport.width}`);
    }
    assert.deepEqual(errors,[]);
    await page.close();
  }
} finally {await browser.close();}
