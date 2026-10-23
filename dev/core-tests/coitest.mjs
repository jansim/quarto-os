// COI via service worker on a server without COOP/COEP headers.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const url = process.argv[2] || 'http://localhost:8212/coi.html';
const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
let navs = 0;
page.on('framenavigated', f => { if (f === page.mainFrame()) navs++; });
page.on('console', m => console.log('[console]', m.type(), m.text().slice(0, 200)));
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load' });
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(500);
  const ok = await page.evaluate(() => window.crossOriginIsolated).catch(() => null);
  if (ok) break;
}
await page.waitForLoadState('load');
console.log('navigations:', navs);
console.log('crossOriginIsolated:', await page.evaluate(() => crossOriginIsolated));
console.log('controller:', await page.evaluate(() => !!navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL));
console.log('SharedArrayBuffer:', await page.evaluate(() => typeof SharedArrayBuffer));
console.log('cx import:', await page.evaluate(async () => { try { const m = await import('https://cxrtnc.leaningtech.com/1.4.0/cx.esm.js'); return 'ok ' + Object.keys(m).slice(0, 6).join(','); } catch (e) { return 'FAIL ' + e; } }));
console.log('cross-origin img:', await page.evaluate(async () => { const i = document.querySelector('img[src^="https://quarto.org"]'); if (!i) return 'no img'; if (!i.complete) await new Promise(r => { i.onload = i.onerror = r; setTimeout(r, 8000); }); return i.naturalWidth > 0 ? 'loaded ' + i.naturalWidth : 'not loaded'; }));
console.log('fresh cross-origin img (no CORP):', await page.evaluate(async () => { const i = new Image(); i.src = 'https://quarto.org/assets/images/quarto.png?t=' + Date.now(); document.body.appendChild(i); await new Promise(r => { i.onload = i.onerror = r; setTimeout(r, 8000); }); return i.naturalWidth > 0 ? 'loaded' : 'blocked'; }));
// Reload again: must not loop, should stay isolated
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(1000);
console.log('after manual reload: navigations', navs, 'COI', await page.evaluate(() => crossOriginIsolated));
// a page without the VM marker, in the same SW scope, must NOT be isolated
await page.goto(url.replace('coi.html', 'minimal.html'), { waitUntil: 'load' });
await page.waitForTimeout(800);
console.log('non-VM page: controlled', await page.evaluate(() => !!navigator.serviceWorker.controller), 'COI', await page.evaluate(() => crossOriginIsolated));
await browser.close();
