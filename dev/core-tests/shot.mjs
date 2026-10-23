// Generic screenshot helper: node shot.mjs <url> <out.png> [w] [h] [fullPage]
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const [url, out, w = 1200, hgt = 900, full = '1'] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: +w, height: +hgt } });
page.on('console', m => { if (m.type() !== 'debug') console.log('[console]', m.type(), m.text().slice(0, 300)); });
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(2500);
await page.screenshot({ path: out, fullPage: full === '1' });
await browser.close();
