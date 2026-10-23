// Document-mode interactions.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const url = process.argv[2] || 'http://localhost:8202/doc.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
page.on('console', m => { if (m.type() === 'warning') console.log('[console]', m.type(), m.text().slice(0, 200)); });
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(1500);
console.log('config', await page.evaluate(() => JSON.stringify(QuartoOS.config)));
console.log('baseUrl', await page.evaluate(() => QuartoOS.baseUrl));
console.log('mounted at load:', await page.evaluate(() => QuartoOS.windows.map(w => w.app + ':' + w.mounted).join(' ')));
// close the inline code window -> closed bar -> reopen
const code = page.locator('.qos-window', { has: page.locator('.qos-title', { hasText: 'hello.py' }) });
await code.locator('.qos-close').click();
await page.waitForTimeout(300);
await page.locator('.qos-closedbar').first().screenshot({ path: 'shots/doc-closedbar.png' });
console.log('closed bar:', await page.locator('.qos-closedbar').count(), 'win hidden:', await code.evaluate(e => e.classList.contains('qos-hidden')));
await page.locator('.qos-reopen').click();
await page.waitForTimeout(300);
console.log('after reopen bars:', await page.locator('.qos-closedbar').count(), 'state', await code.evaluate(e => e.qosWin.state));
// collapse (minimize) the image window
const cat = page.locator('.qos-window', { has: page.locator('.qos-title', { hasText: 'cat.jpg' }) });
await cat.locator('.qos-min').click();
await page.waitForTimeout(200);
console.log('collapsed height', await cat.evaluate(e => e.offsetHeight));
await cat.screenshot({ path: 'shots/doc-collapsed.png' });
await cat.locator('.qos-min').click();
console.log('restored height', await cat.evaluate(e => e.offsetHeight));
// close the inline terminal (app) -> dispose; reopen -> remount
const t1 = page.locator('#t1');
await t1.locator('.qos-close').click();
await page.waitForTimeout(200);
await page.locator('.qos-closedbar .qos-reopen').click();
await page.waitForTimeout(1500);
console.log('t1 events', await page.evaluate(() => JSON.stringify((window.__events || []).filter(e => e[1] === 't1' && e[0] !== 'resize'))));
// run snippet targeting t1
await page.locator('code.qos-run').first().click();
await page.waitForTimeout(600);
// run block button
await page.locator('.qos-runbtn').click();
await page.waitForTimeout(600);
console.log('runs', await page.evaluate(() => JSON.stringify((window.__events || []).filter(e => e[0] === 'run'))));
// zoom the terminal to fullscreen and back with the green button
await t1.locator('.qos-max').click();
await page.waitForTimeout(400);
console.log('fs box', JSON.stringify(await t1.boundingBox()));
await page.screenshot({ path: 'shots/doc-fs.png' });
await t1.locator('.qos-max').click();
await page.waitForTimeout(300);
console.log('after unzoom fs?', await t1.evaluate(e => e.classList.contains('qos-fullscreen')));
// launcher with no desktop -> overlay floating window
await page.locator('.qos-launch').first().click();
await page.waitForTimeout(1200);
console.log('overlay windows', await page.locator('.qos-overlay > .qos-window').count());
await page.screenshot({ path: 'shots/doc-overlay.png' });
// drag the float=true anchored window
const fl = page.locator('.qos-window.qos-floating', { has: page.locator('.qos-title', { hasText: 'Floating note' }) });
await fl.scrollIntoViewIfNeeded();
const b0 = await fl.boundingBox();
await page.mouse.move(b0.x + 120, b0.y + 12); await page.mouse.down(); await page.mouse.move(b0.x - 80, b0.y + 52, { steps: 4 }); await page.mouse.up();
const b1 = await fl.boundingBox();
console.log('float drag dx', Math.round(b1.x - b0.x), 'dy', Math.round(b1.y - b0.y));
// inline grip resize on the terminal
await t1.scrollIntoViewIfNeeded();
const tb = await t1.boundingBox();
await page.mouse.move(tb.x + tb.width - 5, tb.y + tb.height - 5); await page.mouse.down(); await page.mouse.move(tb.x + tb.width - 105, tb.y + tb.height + 55, { steps: 4 }); await page.mouse.up();
const tb2 = await t1.boundingBox();
console.log('grip resize dw', Math.round(tb2.width - tb.width), 'dh', Math.round(tb2.height - tb.height));
await browser.close();
