// Desktop interactions: hover dock (magnify), click dock to open, minimize, maximize, close.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const url = process.argv[2] || 'http://localhost:8202/desk.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 });
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log('[console]', m.type(), m.text().slice(0, 300)); });
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(2000);
const desk = page.locator('.qos-desktop');
const db = await desk.boundingBox();
const clip = { x: db.x - 10, y: db.y - 10, width: db.width + 20, height: db.height + 20 };
// hover the dock's middle icon
const items = page.locator('.qos-dock-apps .qos-dock-item');
const ib = await items.nth(1).boundingBox();
await page.mouse.move(ib.x + ib.width / 2 + 5, ib.y + ib.height / 2);
await page.waitForTimeout(400);
await page.screenshot({ path: 'shots/desk-hover.png', clip });
// click terminal icon twice -> two new terminals (cascade)
await page.mouse.move(10, 10);
await page.waitForTimeout(200);
await items.nth(0).click();
await page.waitForTimeout(300);
await items.nth(0).click();
await page.waitForTimeout(1500);
console.log('windows', await page.evaluate(() => QuartoOS.windows.map(w => [w.id, w.app, w.state, w.el.style.left, w.el.style.top].join(' '))));
await page.screenshot({ path: 'shots/desk-open2.png', clip });
// minimize the focused window
const last = page.locator('.qos-screen > .qos-window').last();
await last.locator('.qos-min').click();
await page.waitForTimeout(600);
await page.screenshot({ path: 'shots/desk-min.png', clip });
// maximize first terminal
await page.evaluate(() => document.getElementById('dt1').qosWin.focus());
await page.locator('#dt1 .qos-max').click();
await page.waitForTimeout(600);
await page.screenshot({ path: 'shots/desk-max.png', clip });
// restore from dock
await page.locator('.qos-dock-mini').first().click();
await page.waitForTimeout(600);
console.log('after restore', await page.evaluate(() => QuartoOS.windows.map(w => w.id + ':' + w.state).join(' ')));
// close dt1
await page.locator('#dt1 .qos-max').click();
await page.waitForTimeout(400);
await page.locator('#dt1 .qos-close').click();
await page.waitForTimeout(500);
console.log('after close', await page.evaluate(() => QuartoOS.windows.map(w => w.id + ':' + w.state).join(' ')), await page.evaluate(() => JSON.stringify(window.__events)));
// drag the cat window by its title bar
const cat = page.locator('.qos-screen > .qos-window', { hasText: '' }).filter({ has: page.locator('.qos-title', { hasText: 'cat.jpg' }) });
await cat.evaluate(e => e.qosWin.focus());
const tb = await cat.locator('.qos-titlebar').boundingBox();
await page.mouse.move(tb.x + tb.width / 2, tb.y + 10);
await page.mouse.down();
await page.mouse.move(tb.x + tb.width / 2 - 200, tb.y + 60, { steps: 5 });
await page.mouse.up();
// resize via the se handle
const cb = await cat.boundingBox();
await page.mouse.move(cb.x + cb.width + 2, cb.y + cb.height + 2);
await page.mouse.down();
await page.mouse.move(cb.x + cb.width + 82, cb.y + cb.height + 42, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(300);
console.log('cat', await cat.evaluate(e => [e.style.left, e.style.top, e.style.width, e.style.height].join(' ')));
// run snippet -> last focused terminal
await page.locator('code.qos-run').click();
await page.waitForTimeout(1500);
console.log('events', await page.evaluate(() => JSON.stringify(window.__events.filter(e => e[0] === 'run'))));
await page.screenshot({ path: 'shots/desk-final.png', clip });
await browser.close();
