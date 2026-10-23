// Boot CheerpX for real on the SW-isolated page (nocoi server).
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto(process.argv[2] || 'http://localhost:8212/coi.html', { waitUntil: 'load' });
for (let i = 0; i < 20 && !(await page.evaluate(() => crossOriginIsolated).catch(() => false)); i++) await page.waitForTimeout(500);
await page.waitForLoadState('load');
console.log('COI', await page.evaluate(() => crossOriginIsolated));
const t0 = Date.now();
const out = await page.evaluate(async () => {
  const CheerpX = await import('https://cxrtnc.leaningtech.com/1.4.0/cx.esm.js');
  const cloud = await CheerpX.CloudDevice.create('wss://disks.webvm.io/debian_buster_large_permis_fixed_01-06-2026.ext2');
  const idb = await CheerpX.IDBDevice.create('qos-coi-test');
  const overlay = await CheerpX.OverlayDevice.create(cloud, idb);
  const cx = await CheerpX.Linux.create({ mounts: [{ type: 'ext2', dev: overlay, path: '/' }, { type: 'devs', path: '/dev' }, { type: 'proc', path: '/proc' }] });
  let log = '';
  const dec = new TextDecoder();
  cx.setCustomConsole(buf => { log += dec.decode(new Uint8Array(buf)); }, 80, 24);
  const r = await cx.run('/bin/bash', ['-c', 'echo HELLO-FROM-$(uname -m); git --version'], { env: ['HOME=/home/user', 'PATH=/usr/bin:/bin'], cwd: '/home/user', uid: 1000, gid: 1000 });
  return 'exit ' + r.status + ' ' + log.trim();
}).catch(e => 'ERR ' + e.message);
console.log(out, 'in', Date.now() - t0, 'ms');
await browser.close();
