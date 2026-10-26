// Real-machine persistence, failure and reset checks. Run the repository server.
import assert from 'node:assert/strict';
import {chromium} from '../playwright.mjs';
const index = process.argv.indexOf('--port');
const port = index < 0 ? '8203' : process.argv[index + 1];
const cache = `qos-lifecycle-${Date.now()}`;
const url = `http://localhost:${port}/dev/vm-test.html?suite=boot&persist=1&cache=${cache}`;
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  async function ready() {
    await page.waitForFunction(() => window.__done, null, {timeout:150000});
    assert(await page.evaluate(() => vm.isReady), JSON.stringify(await page.evaluate(() => __results)));
  }
  await page.goto(url); await ready();
  const invalid = await page.evaluate(async () => {
    const {createVM} = await import('/_extensions/quarto-os/vm/vm.js');
    const errors = [];
    for (const config of [{memory:0}, {assetBase:'/missing-vm-assets/'}, {assetBase:'/vm-assets/',bootTimeout:1}, {disk:'old.ext2'}]) {
      try { const machine = await createVM(config); await machine.ready; errors.push('unexpected success'); }
      catch(error) {errors.push(error.message);}
    }
    return errors;
  });
  assert(invalid[0].includes('memory')); assert(invalid[1].includes('HTTP 404')); assert(invalid[2].includes('timed out')); assert(invalid[3].includes('asset-base'));
  console.log('PASS invalid configuration, missing assets and bounded boot failure');

  await page.evaluate(async () => {
    await vm.writeFile('~/checkpoint.txt','baseline');
    await vm._emulator.create_file('checkpoint-share.txt',new TextEncoder().encode('shared baseline'));
    await vm.openSession({cmd:'sleep 600'});
    await vm.ping();
    const inFlight = vm.exec('sleep 1; echo completed > ~/in-flight.txt');
    if (!await vm.save()) throw new Error('Snapshot deferred unexpectedly');
    await inFlight;
  });
  console.log('PASS explicit checkpoint with a live PTY and mutable 9p data');
  const failed = await page.evaluate(async () => {
    await vm.writeFile('~/checkpoint.txt','unsaved');
    const original = vm._db.transaction.bind(vm._db);
    vm._db.transaction = (...args) => {
      const transaction = original(...args);
      queueMicrotask(() => transaction.abort());
      return transaction;
    };
    try {await vm.save(); return false;}
    catch {return true;}
    finally {vm._db.transaction = original;}
  });
  assert(failed);
  await page.reload(); await ready();
  const restored = await page.evaluate(async () => ({
    file:await vm.readText('~/checkpoint.txt'),
    inFlight:await vm.readText('~/in-flight.txt'),
    shared:new TextDecoder().decode(await vm._emulator.read_file('checkpoint-share.txt')),
    processes:(await vm.exec('for p in /proc/[0-9]*; do [ "$(cat "$p/comm" 2>/dev/null)" = sleep ] && echo "$p"; done; true')).output.trim(),
  }));
  assert.equal(restored.file,'baseline'); assert.equal(restored.inFlight,'completed\n'); assert.equal(restored.shared,'shared baseline'); assert.equal(restored.processes,'');
  console.log('PASS aborted storage write retains last committed checkpoint across reload');
  console.log('PASS restore retains 9p data and kills stale terminal processes');
  await Promise.all([page.waitForNavigation(),page.evaluate(() => vm.reset())]);
  await ready();
  assert.equal(await page.evaluate(() => vm.stat('~/checkpoint.txt')),null);
  assert.equal(await page.evaluate(() => vm._emulator.read_file('checkpoint-share.txt').then(()=>true,()=>false)),false);
  console.log('PASS reset clears the persisted machine and restores pristine files');
} finally {await browser.close();}
