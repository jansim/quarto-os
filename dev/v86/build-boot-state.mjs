// Produce a public, pristine machine state before qos-agent or lesson setup runs.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {gzip} from 'node:zlib';
import {promisify} from 'node:util';

const [directory, modulePath, memoryArg = '512'] = process.argv.slice(2);
if (!directory || !modulePath) throw new Error('Usage: build-boot-state.mjs ASSETS LIBV86_MODULE [MEMORY_MIB]');
const root = path.resolve(directory);
const memory = Number(memoryArg);
if (!Number.isInteger(memory) || memory < 256 || memory > 2048) throw new Error('Invalid snapshot memory');
const {V86} = await import(pathToFileURL(path.resolve(modulePath)).href);
const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
let emulator;
let timer;
try {
  const start = performance.now();
  emulator = new V86({
    wasm_path: path.resolve(path.dirname(modulePath), 'v86.wasm'),
    bios: {url:path.join(root, 'seabios.bin')}, vga_bios: {url:path.join(root, 'vgabios.bin')},
    bzimage: {url:path.join(root, 'bzimage')}, initrd: {url:path.join(root, 'initrd.gz')},
    memory_size: memory * 1024 * 1024,
    filesystem: {basefs:path.join(root, 'fs.json'), baseurl:path.join(root, 'rootfs') + path.sep},
    autostart: false, disable_keyboard: true, disable_mouse: true, disable_speaker: true,
    cmdline: 'console=ttyS0 tsc=reliable mitigations=off random.trust_cpu=on init=/init',
  });
  let text = '', reads = 0;
  emulator.add_listener('9p-read-start', () => reads++);
  emulator.add_listener('9p-read-end', () => reads--);
  const prompt = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Pristine guest boot timed out: ' + text.slice(-3000))), 150000);
    emulator.add_listener('serial0-output-byte', byte => {
      text = (text + String.fromCharCode(byte)).slice(-4096);
      if (text.includes('Kernel panic - not syncing')) reject(new Error(text));
      if (text.includes('QOS_READY# ')) resolve();
    });
  });
  await new Promise(resolve => emulator.add_listener('emulator-ready', resolve));
  await emulator.run();
  await prompt;
  await new Promise(resolve => setTimeout(resolve, 100));
  await emulator.stop();
  const deadline = performance.now() + 10000;
  while (reads) {
    if (performance.now() > deadline) throw new Error('9p reads did not settle before snapshot');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const state = await emulator.save_state();
  const compressed = await promisify(gzip)(new Uint8Array(state));
  const sha256 = createHash('sha256').update(compressed).digest('hex');
  const file = `boot-state-${sha256.slice(0,16)}.bin.gz`;
  await fs.writeFile(path.join(root, file), compressed);
  manifest.bootState = {file, memory, sha256, bytes:compressed.length};
  await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  // Keep local rebuilds as small as a fresh CI publication.
  for (const name of await fs.readdir(root)) {
    if (name !== file && /^boot-state-[a-f0-9]{16}\.bin\.gz$/.test(name))
      await fs.unlink(path.join(root, name));
  }
  console.log(JSON.stringify({bootMs:Math.round(performance.now() - start), snapshotBytes:compressed.length, memory}, null, 2));
} finally {
  clearTimeout(timer);
  emulator?.destroy();
}
