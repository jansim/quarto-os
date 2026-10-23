import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const [url, js, wait = 1500] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(+wait);
console.log(await page.evaluate(js));
await browser.close();
