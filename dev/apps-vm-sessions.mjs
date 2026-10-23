// Repro for the real VM (vm/vm.js + qos-agent): pty session behaviour, as seen by the apps.
//   node dev/server.mjs . 8203 &  then  node dev/apps-vm-sessions.mjs
// Expected: A's prompt arrives by itself; B's prompt/output arrive on B (not on A).
// Observed 2026-10-23 23:10 UTC: no prompt until the first input byte; everything of B shows up on A.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://localhost:${process.argv[2] || 8203}/dev/apps-test.html?vm=real`);
await page.waitForFunction(() => window.QuartoOS);
const log = await page.evaluate(async () => {
  const vm = await QuartoOS.vm(); await vm.ready;
  const dec = new TextDecoder(), log = [], t0 = performance.now(), T = () => Math.round(performance.now() - t0);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const a = await vm.openSession({ cols: 80, rows: 24, cwd: '~' });
  a.onData(d => log.push(`${T()} A ← ${JSON.stringify(dec.decode(d))}`));
  await sleep(4000); log.push(`${T()} A → echo AAA`); a.write('echo AAA\r');
  await sleep(1500);
  const b = await vm.openSession({ cols: 80, rows: 24, cwd: '/tmp' });
  b.onData(d => log.push(`${T()} B ← ${JSON.stringify(dec.decode(d))}`));
  await sleep(3000); log.push(`${T()} B → echo BBB`); b.write('echo BBB\r');
  await sleep(1500);
  return log;
});
console.log(log.join('\n'));
await browser.close();
