// reveal.js tests: screenshots of each slide + interactions.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const base = process.argv[2] || 'http://localhost:8202/slides.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log('[console]', m.type(), m.text().slice(0, 300)); });
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto(base, { waitUntil: 'load' });
await page.waitForTimeout(1200);
const idx = () => page.evaluate(() => Reveal.getIndices().h);
console.log('scale', await page.evaluate(() => Reveal.getScale()));
for (let i = 1; i <= 5; i++) {
  await page.evaluate(i => Reveal.slide(i), i);
  await page.waitForTimeout(1300);
  await page.screenshot({ path: `shots/sl-${i}.png` });
}
// slide 3: drag floating window by 100px screen -> expect 100/scale slide px
await page.evaluate(() => Reveal.slide(3));
await page.waitForTimeout(800);
const fw = page.locator('section.present .qos-window.qos-floating').first();
const before = await fw.evaluate(e => [e.offsetLeft, e.offsetTop]);
const tb = await fw.locator('.qos-titlebar').boundingBox();
await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
await page.mouse.down();
await page.mouse.move(tb.x + tb.width / 2 - 100, tb.y + tb.height / 2 + 50, { steps: 6 });
await page.mouse.up();
const after = await fw.evaluate(e => [e.offsetLeft, e.offsetTop]);
const sc = await page.evaluate(() => Reveal.getScale());
console.log('drag before', before, 'after', after, 'expected dx', (-100 / sc).toFixed(1), 'dy', (50 / sc).toFixed(1));
// keyboard inside the window shouldn't change slide
await fw.evaluate(e => { const d = document.createElement('div'); d.tabIndex = 0; d.id = 'focusme'; d.textContent = 'focusable'; e.querySelector('.qos-body').appendChild(d); });
await page.locator('#focusme').focus();
await page.keyboard.press('ArrowRight');
await page.keyboard.type('hello world');
await page.waitForTimeout(400);
console.log('slide after ArrowRight inside window (expect 3):', await idx());
// launcher in slide 3 -> floating terminal in the slide
await page.locator('section.present .qos-launch').click();
await page.waitForTimeout(1200);
console.log('windows in slide 3:', await page.evaluate(() => document.querySelectorAll('section.present .qos-window').length));
await page.screenshot({ path: 'shots/sl-3b.png' });
// zoom the launched terminal -> fullscreen
const t = page.locator('section.present .qos-window.qos-app-terminal').last();
await t.locator('.qos-max').click();
await page.waitForTimeout(500);
const r = await t.boundingBox();
console.log('fullscreen box', r, 'popover open', await t.evaluate(e => e.matches(':popover-open')));
await page.screenshot({ path: 'shots/sl-3-fs.png' });
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
console.log('after Esc fullscreen?', await t.evaluate(e => e.classList.contains('qos-fullscreen')), 'overview?', await page.evaluate(() => Reveal.isOverview()), 'slide', await idx());
// slide 2: run snippet targeting st1
await page.evaluate(() => Reveal.slide(2));
await page.waitForTimeout(1500);
await page.locator('section.present code.qos-run').first().click();
await page.locator('section.present code.qos-run').nth(1).click();
await page.waitForTimeout(800);
console.log('runs', await page.evaluate(() => JSON.stringify((window.__events || []).filter(e => e[0] === 'run'))));
await page.screenshot({ path: 'shots/sl-2b.png' });
// slide 5: run block without target and no terminal in slide -> new floating terminal in slide
await page.evaluate(() => Reveal.slide(5));
await page.waitForTimeout(800);
await page.locator('section.present .qos-runbtn').click();
await page.waitForTimeout(1500);
console.log('runs', await page.evaluate(() => JSON.stringify((window.__events || []).filter(e => e[0] === 'run'))));
await page.screenshot({ path: 'shots/sl-5b.png' });
// normal keyboard nav still works outside windows
await page.locator('body').click({ position: { x: 5, y: 5 } });
await page.keyboard.press('ArrowLeft');
await page.waitForTimeout(500);
console.log('slide after ArrowLeft outside (expect 4):', await idx());
await browser.close();
