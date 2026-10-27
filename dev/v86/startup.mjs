// Cold-browser boot measurements and clean-snapshot failure regressions (no automatic kernel fallback).
import assert from 'node:assert/strict';
import {chromium} from '../playwright.mjs';
const index = process.argv.indexOf('--port');
const port = index < 0 ? '8203' : process.argv[index + 1];
const base = `http://localhost:${port}`;
const browser = await chromium.launch();
const measurements = [];
try {
  for (const scenario of ['snapshot', 'kernel', 'missing', 'corrupt', 'memory-mismatch']) {
    const context = await browser.newContext();
    try {
      if (scenario === 'missing' || scenario === 'corrupt') {
        await context.route('**/boot-state-*.bin.gz', route => route.fulfill(
          scenario === 'missing' ? {status:404,body:'Missing snapshot'} : {status:200,body:'Invalid snapshot'},
        ));
      }
      if (scenario === 'memory-mismatch') {
        await context.route('**/vm-assets/manifest.json', async route => {
          const response = await route.fetch();
          const manifest = await response.json();
          manifest.bootState.memory = 1024;
          await route.fulfill({response,json:manifest});
        });
      }
      const page = await context.newPage();
      const failures = [];
      page.on('pageerror', error => failures.push(error.message));
      await page.addInitScript(() => performance.setResourceTimingBufferSize(10000));
      const start = performance.now();
      await page.goto(`${base}/dev/vm-test.html?suite=boot&boot-snapshot=${scenario === 'kernel' ? '0' : '1'}`);
      await page.waitForFunction(() => window.__done, null, {timeout:150000});
      const readyMs = Math.round(performance.now() - start);
      const state = await page.evaluate(() => ({ready:vm.isReady,mode:vm.bootMode,results:__results}));
      if (['missing', 'corrupt', 'memory-mismatch'].includes(scenario)) {
        assert.equal(state.ready, false);
        const error = state.results.find(result => !result.ok)?.error || '';
        const expected = {missing:'HTTP 404', corrupt:'checksum mismatch', 'memory-mismatch':'memory does not match'};
        assert(error.includes(expected[scenario]), JSON.stringify(state));
        const paths = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => new URL(entry.name).pathname));
        assert(!paths.some(file => file.endsWith('/bzimage') || file.endsWith('/initrd.gz')), 'Must not fall back to kernel boot');
        console.log(`PASS ${scenario}: startup reports ${expected[scenario]} without a fallback`);
        continue;
      }
      assert(state.ready, JSON.stringify(state));
      assert.equal(state.mode, scenario === 'snapshot' ? 'snapshot' : 'kernel');
      const atReady = await page.evaluate(() => performance.getEntriesByType('resource')
        .filter(entry => new URL(entry.name).pathname.startsWith('/vm-assets/'))
        .map(entry => ({file:new URL(entry.name).pathname,bytes:entry.decodedBodySize})));
      assert.equal(atReady.some(r => r.file.endsWith('/initrd.gz')), scenario !== 'snapshot');
      assert.equal(atReady.some(r => r.file.includes('/boot-state-')), !['kernel','memory-mismatch'].includes(scenario));
      assert(atReady.some(r => r.file.includes('/rootfs/')), 'Expected demand-loaded root files');
      assert(!atReady.some(r => r.file.includes('guest-sources')), 'Sources must not load during startup');
      measurements.push({scenario,readyMs,assetBytes:atReady.reduce((sum,r)=>sum+r.bytes,0),
        rootFiles:atReady.filter(r=>r.file.includes('/rootfs/')).length});
      // Python must fault in successfully after restore; the clean state's clock
      // must also be updated before lesson setup and file timestamps are used.
      const result = await page.evaluate(() => vm.exec('python3 -c "import json,email,time; print(6*7); print(int(time.time()))"'));
      assert.equal(result.code,0,JSON.stringify(result));
      const [answer,clock] = result.output.trim().split('\n');
      assert.equal(answer,'42');
      assert(Math.abs(Number(clock) - Date.now()/1000) < 120, `Stale guest clock: ${clock}`);
      assert.deepEqual(failures,[]);
      console.log(`PASS ${scenario}: ${JSON.stringify(measurements.at(-1))}`);
    } finally {await context.close();}
  }
  console.log(JSON.stringify({measurements,note:'Local HTTP, fresh browser contexts; unencoded response body bytes for VM assets only. Timing is machine-specific.'},null,2));
} finally {await browser.close();}
