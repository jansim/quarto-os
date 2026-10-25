// Integration with the real apps + VM (nocoi server → SW isolation → real CheerpX boot).
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const url = process.argv[2] || 'http://localhost:8212/integ/lesson.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log('[console]', m.type(), m.text().slice(0, 300)); });
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load' });
for (let i = 0; i < 20 && !(await page.evaluate(() => crossOriginIsolated).catch(() => false)); i++) await page.waitForTimeout(500);
await page.waitForLoadState('load');
console.log('COI', await page.evaluate(() => crossOriginIsolated));
const t0 = Date.now();
for (let i = 0; i < 90; i++) {
  await page.waitForTimeout(1000);
  const txt = await page.evaluate(() => document.querySelector('#t1 .qos-body').innerText);
  if (/\$\s*$/m.test(txt) && /user|\$/.test(txt) && i > 3) break;
}
console.log('terminal ready after', Date.now() - t0, 'ms');
await page.locator('code.qos-run').click();
await page.waitForTimeout(4000);
console.log('terminal text:\n' + (await page.evaluate(() => { const r = document.querySelector('#t1 .xterm-rows'); return r ? r.innerText : document.querySelector('#t1 .qos-body').innerText; })).split('\n').filter(Boolean).slice(-12).join('\n'));
await page.screenshot({ path: 'shots/integ.png', fullPage: true });
await browser.close();
