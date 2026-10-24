// Runs dev/vm-test.html in headless Chromium against the real CheerpX + disk.
//
//   node dev/server.mjs . 8201 &      # COOP/COEP static server
//   node dev/vm-test.mjs [--port 8201] [--suite main|idle|persist|all] [--verbose]
//
// Exit code 0 when every test passed.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const port = arg('port', '8201');
const which = arg('suite', 'all');
const verbose = process.argv.includes('--verbose');
const base = `http://localhost:${port}/dev/vm-test.html`;

const browser = await chromium.launch({ args: ['--enable-features=SharedArrayBuffer'] });
const context = await browser.newContext();
const page = await context.newPage();
page.on('console', (m) => {
  const t = m.text();
  if (verbose || m.type() === 'error' || m.type() === 'warning' || t.startsWith('[quarto-os')) console.log(`  [${m.type()}] ${t.slice(0, 400)}`);
});
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));

let failed = 0;
const all = [];
async function runSuite(query, timeout = 900000) {
  console.log(`\n=== ${query}`);
  const shown = new Set();
  await page.goto(`${base}?${query}`);
  const t0 = Date.now();
  for (;;) {
    const st = await page.evaluate(() => ({ done: !!window.__done, results: window.__results || [], timings: window.__timings || {} }));
    for (const r of st.results) {
      if (shown.has(r.name)) continue;
      shown.add(r.name);
      const info = r.info === undefined ? '' : ` — ${typeof r.info === 'string' ? r.info : JSON.stringify(r.info)}`;
      console.log(r.ok ? `PASS ${r.name} (${r.ms} ms)${info}` : `FAIL ${r.name}\n     ${r.error.split('\n').slice(0, 4).join('\n     ')}`);
    }
    if (st.done) {
      all.push(...st.results);
      failed += st.results.filter((r) => !r.ok).length;
      console.log('timings', JSON.stringify(st.timings));
      return st;
    }
    if (Date.now() - t0 > timeout) { console.log('TIMEOUT'); failed++; return st; }
    await new Promise((r) => setTimeout(r, 500));
  }
}

if (which === 'main' || which === 'all') await runSuite('suite=main');
if (which === 'idle' || which === 'all') await runSuite('suite=idle');
if (which === 'persist' || which === 'all') {
  const cache = `qos-test-${Date.now()}`;
  for (const phase of ['persist1', 'persist2', 'persist3']) await runSuite(`suite=${phase}&cache=${cache}`);
}
console.log(`\n${all.length - failed}/${all.length} passed`);
await browser.close();
process.exit(failed ? 1 : 0);
