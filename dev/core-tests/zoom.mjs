// node zoom.mjs <url> <out.png> <selector> [index] [pad] [dsf] [vw] [vh]
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const [url, out, sel, idx = 0, pad = 30, dsf = 2, vw = 1200, vh = 900] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: +vw, height: +vh }, deviceScaleFactor: +dsf });
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(2500);
const el = page.locator(sel).nth(+idx);
await el.scrollIntoViewIfNeeded();
const b = await el.boundingBox();
await page.screenshot({ path: out, clip: { x: Math.max(0, b.x - pad), y: Math.max(0, b.y - pad), width: b.width + 2 * pad, height: b.height + 2 * pad } });
await browser.close();
