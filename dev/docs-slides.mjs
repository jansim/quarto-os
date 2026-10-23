// Screenshot every slide of a rendered reveal.js deck.
// Usage: node dev/docs-slides.mjs <url> <outDir> [--wait=ms] [--prefix=name]
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const [url, outDir] = args.filter((a) => !a.startsWith('--'));
const wait = +(flags.wait ?? 1500);
const prefix = flags.prefix ?? 'slide';
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) logs.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.Reveal && Reveal.isReady && Reveal.isReady());
const total = await page.evaluate(() => Reveal.getTotalSlides());
for (let i = 0; i < total; i++) {
  await page.evaluate((i) => Reveal.slide(i), i);
  await page.waitForTimeout(wait);
  const f = path.join(outDir, `${prefix}-${String(i + 1).padStart(2, '0')}.png`);
  await page.screenshot({ path: f });
  console.log(f);
}
for (const l of logs) console.log('   ', l);
await browser.close();
