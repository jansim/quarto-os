// Verifies the integration fixes: headings in slide windows, floating content height, wallpaper URL,
// grid cells, dark palette, narrow-screen clamping.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const B = 'http://localhost:8202/';
const browser = await chromium.launch();
let page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', e => console.log('[pageerror]', e.message));
page.on('requestfailed', r => console.log('[requestfailed]', r.url()));
page.on('response', r => { if (r.status() >= 400) console.log('[http ' + r.status() + ']', r.url()); });
await page.goto(B + 'slides2.html', { waitUntil: 'load' });
await page.waitForTimeout(1000);
console.log('total slides (expect 5):', await page.evaluate(() => Reveal.getTotalSlides()), 'vertical stacks:', await page.evaluate(() => document.querySelectorAll('.reveal .slides > section.stack').length));
const seen = [];
for (let i = 0; i < 5; i++) { seen.push(await page.evaluate(() => Reveal.getCurrentSlide().id)); await page.keyboard.press('ArrowRight'); await page.waitForTimeout(250); }
console.log('ArrowRight walk:', seen.join(' > '));
await page.evaluate(() => Reveal.slide(1)); await page.waitForTimeout(600);
await page.screenshot({ path: 'shots/fix-slideA.png' });
await page.evaluate(() => Reveal.slide(2)); await page.waitForTimeout(600);
console.log('floating content window height (fits content):', await page.evaluate(() => { const w = document.querySelector('section.present .qos-window'); return w.offsetHeight + ' body scrollH ' + w.querySelector('.qos-body').scrollHeight; }));
await page.screenshot({ path: 'shots/fix-slideB.png' });
await page.evaluate(() => Reveal.slide(3)); await page.waitForTimeout(800);
console.log('wallpaper:', await page.evaluate(() => getComputedStyle(document.querySelector('section.present .qos-desktop')).getPropertyValue('--qos-wallpaper').slice(0, 120)));
await page.screenshot({ path: 'shots/fix-slideC.png' });
await page.close();

page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 });
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto(B + 'grid.html', { waitUntil: 'load' });
await page.waitForTimeout(1200);
console.log('grid cells:', await page.evaluate(() => [...document.querySelectorAll('.grid > .qos-window')].map(w => w.offsetWidth + '/' + w.parentNode.offsetWidth + ' m=' + getComputedStyle(w).margin).join(' | ')));
console.log('sized window centred:', await page.evaluate(() => { const w = [...document.querySelectorAll('.qos-window')].find(x => x.qosWin.title === 'sized'); const r = w.getBoundingClientRect(), p = w.parentNode.getBoundingClientRect(); return Math.round(r.left - p.left) + ' vs ' + Math.round(p.right - r.right); }));
console.log('dark kw colour:', await page.evaluate(() => { const k = document.querySelector('.qos-dark code span.kw, .qos-dark code span.im'); return k ? getComputedStyle(k).color : 'none'; }), 'inline code bg:', await page.evaluate(() => getComputedStyle(document.querySelector('.qos-dark p code')).backgroundColor));
await page.screenshot({ path: 'shots/fix-grid.png', fullPage: true });
// narrow: desktop window must be clamped / shrunk into the desktop and grow back
await page.setViewportSize({ width: 390, height: 800 });
await page.waitForTimeout(600);
const geo = () => page.evaluate(() => { const d = document.querySelector('#narrow .qos-screen'), w = d.querySelector('.qos-window'); return `desk ${d.clientWidth} win x=${w.offsetLeft} w=${w.offsetWidth} right=${w.offsetLeft + w.offsetWidth}`; });
console.log('narrow:', await geo());
await page.locator('#narrow').screenshot({ path: 'shots/fix-narrow.png' });
await page.setViewportSize({ width: 1200, height: 900 });
await page.waitForTimeout(600);
console.log('wide again:', await geo());
await browser.close();
