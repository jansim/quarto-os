// Screenshot the rendered docs site (served by dev/server.mjs) with Playwright.
// Usage: node dev/docs-shots.mjs <baseUrl> <outDir> [page ...] [--wait=ms] [--width=px] [--height=px] [--full]
//   e.g. node dev/docs-shots.mjs http://localhost:8204 /tmp/shots index.html examples/windows.html --wait=4000 --full
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => {
  const [k, v] = a.slice(2).split('=');
  return [k, v ?? true];
}));
const [base, outDir, ...pages] = args.filter((a) => !a.startsWith('--'));
const wait = +(flags.wait ?? 3000);
const width = +(flags.width ?? 1440);
const height = +(flags.height ?? 900);
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width, height } });
for (const p of pages.length ? pages : ['index.html']) {
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) logs.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => logs.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  await page.goto(`${base}/${p}`, { waitUntil: 'load' });
  await page.waitForTimeout(wait);
  const name = p.replace(/[\/#?]/g, '_').replace(/\.html$/, '') + (flags.suffix ? '-' + flags.suffix : '') + '.png';
  await page.screenshot({ path: path.join(outDir, name), fullPage: !!flags.full });
  const info = await page.evaluate(() => ({
    coi: self.crossOriginIsolated,
    windows: document.querySelectorAll('.qos-window').length,
    hasOS: typeof window.QuartoOS,
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }));
  console.log(`== ${p} -> ${name}`, JSON.stringify(info));
  for (const l of logs) console.log('   ', l);
  await page.close();
}
await browser.close();
