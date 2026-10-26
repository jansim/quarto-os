// Feasibility checks against a real v86 Linux guest, independent of Quarto OS.
// See README.md for preparation. No cross-origin isolation or remote runtime.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
};
const assets = path.resolve(arg('assets', 'dev/v86/out'));
const playwright = arg('playwright', 'playwright');
const { chromium } = await import(playwright.startsWith('/') ? pathToFileURL(playwright).href : playwright);
const html = `<!doctype html><meta charset="utf-8"><title>v86 feasibility test</title>
<script src="node_modules/v86/build/libv86.js"></script><script>
window.output = '';
window.emulator = new V86({
  wasm_path: 'node_modules/v86/build/v86.wasm',
  bios: {url: 'seabios.bin'}, vga_bios: {url: 'vgabios.bin'},
  bzimage: {url: 'bzimage'}, initrd: {url: 'initrd.gz'},
  memory_size: 1024 * 1024 * 1024, filesystem: {}, autostart: true,
  cmdline: 'console=ttyS0 tsc=reliable mitigations=off random.trust_cpu=on init=/init'
});
emulator.add_listener('serial0-output-byte', b => { window.output += String.fromCharCode(b); });
</script>`;

// Deliberately omit COOP/COEP headers to exercise ordinary static-site hosting.
const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      return;
    }
    const file = path.resolve(assets, `.${pathname}`);
    if (!file.startsWith(assets + path.sep)) {
      res.writeHead(403); res.end(); return;
    }
    const data = await fs.readFile(file);
    const type = file.endsWith('.wasm') ? 'application/wasm' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type }); res.end(data);
  } catch {
    res.writeHead(404); res.end();
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  const executablePath = arg('chromium', undefined);
  browser = await chromium.launch(executablePath ? { executablePath } : {});
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const start = performance.now();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => output.includes('QOS_READY#'), null, { timeout: 120000 });
  assert.equal(await page.evaluate(() => crossOriginIsolated), false);
  console.log(`PASS Linux serial shell without COOP/COEP (${Math.round(performance.now() - start)} ms)`);
  await page.evaluate(() => emulator.serial0_send('stty -echo\n'));
  await page.waitForTimeout(250);

  async function run(command) {
    const tag = 'END_' + randomUUID().replaceAll('-', '');
    await page.evaluate(([command, tag]) => {
      output = '';
      emulator.serial0_send(command + '; printf "\\n' + tag + ':%s\\n" "$?"\n');
    }, [command, tag]);
    await page.waitForFunction(tag => new RegExp(tag + ':\\d+\\r?\\n').test(output), tag, { timeout: 30000 });
    const output = await page.evaluate(() => window.output);
    assert(output.includes(tag + ':0'), `${command}\n${output}`);
    const bytes = Uint8Array.from(output.slice(0, output.indexOf(tag)), c => c.charCodeAt(0));
    return new TextDecoder().decode(bytes).trim();
  }

  const versions = await run('uname -sr; bash --version | head -1; git --version; python3 --version');
  assert(versions.includes('GNU bash,') && versions.includes('git version ') && versions.includes('Python 3.'));
  console.log(versions);
  const payload = [...new TextEncoder().encode('host → guest\n')];
  await page.evaluate(bytes => emulator.create_file('host.txt', new Uint8Array(bytes)), payload);
  const guest = await run('cat /mnt/host/host.txt');
  assert(guest.includes('host → guest'));
  await run("printf 'guest-to-host' > /mnt/host/guest.txt");
  assert.equal(await page.evaluate(async () => new TextDecoder().decode(await emulator.read_file('guest.txt'))), 'guest-to-host');
  console.log('PASS host/guest file exchange through virtio 9p');

  await run("python3 -c 'import os; m,s=os.openpty(); os.write(s,b\"pty-ok\"); assert b\"pty-ok\" in os.read(m,100); os.close(m); os.close(s)'");
  console.log('PASS real Linux PTY allocation and I/O');
  await run('mkdir -p /root/repo && cd /root/repo && git init -q && git config user.name Student && git config user.email student@example.com && echo hello > README.md && git add README.md && git commit -qm first');
  assert((await run('cd /root/repo && git log -1 --format=%s')).includes('first'));
  console.log('PASS Git init, stage, commit, and log inside the guest');

  await run('echo persistent > /root/spike.txt');
  await page.evaluate(async () => {
    await emulator.stop(); window.saved = await emulator.save_state(); await emulator.run();
  });
  await run('rm /root/spike.txt');
  await page.evaluate(async () => {
    await emulator.stop(); await emulator.restore_state(saved); await emulator.run();
  });
  assert((await run('cat /root/spike.txt')).includes('persistent'));
  console.log('PASS in-memory machine snapshot restores a guest file');
  assert.deepEqual(errors, []);
  console.log('PASS no browser JavaScript errors');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
