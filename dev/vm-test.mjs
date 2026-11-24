// Tests vm/vm.js on the real unkernel guest in headless Chromium.
//
//   node dev/vm/build.mjs && node dev/server.mjs . 8203 nocoi &
//   node dev/vm-test.mjs [--port 8203] [--network]   (--network: on-demand apk install via Wisp)
//
// Exit code 0 when every test passed.
import { chromium } from './playwright.mjs';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const base = `http://localhost:${arg('port', '8203')}/dev/vm-test.html`;
const browser = await chromium.launch();
const context = await browser.newContext();
let failed = 0, passed = 0, page;

async function open(query = '') {
  page = await context.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await page.goto(`${base}?${query}`);
  return page.evaluate(() => window.booted);
}
async function test(name, fn) {
  const t = performance.now();
  try {
    const info = await fn();
    passed++;
    console.log(`PASS ${name} (${Math.round(performance.now() - t)} ms)${info === undefined ? '' : ' — ' + JSON.stringify(info)}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${String(e.message || e).split('\n').slice(0, 6).join('\n     ')}`);
  }
}
// Runs fn(vm, helpers) in the page; helpers.term(opts) opens a session and collects its output.
const inVM = (fn, arg) => page.evaluate(async ([src, arg]) => {
  const fn = new Function(`return (${src})`)();
  const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const term = async (opts) => {
    const s = await vm.openSession(opts), dec = new TextDecoder();
    s.text = ''; s.onData((d) => { s.text += dec.decode(d, { stream: true }); });
    s.until = async (re, ms = 15000) => { const t = Date.now(); while (!re.test(s.text)) { if (Date.now() - t > ms) throw new Error(`timeout waiting for ${re}: ${JSON.stringify(s.text.slice(-300))}`); await sleep(20); } };
    return s;
  };
  return fn(window.vm, { assert, sleep, term }, arg);
}, [fn.toString(), arg]);

await test('boot + setup script ran, output on the status channel', async () => {
  const ms = await open(`setup=${encodeURIComponent('echo setup-line; echo run >> ~/setup-count')}`);
  const r = await inVM(async (vm, { assert }) => {
    assert(statuses.includes('setup-line'), JSON.stringify(statuses));
    assert((await vm.readText('~/setup-count')) === 'run\n');
    return { readyMs: Math.round(await window.booted) };
  });
  return { ...r, pageMs: Math.round(ms) };
});

await test('exec: merged output, exit code, cwd, env, errors, abort', () => inVM(async (vm, { assert }) => {
  let r = await vm.exec('echo out; echo err >&2; exit 3');
  assert(r.code === 3 && r.output === 'out\nerr\n', JSON.stringify(r));
  r = await vm.exec('pwd; echo $FOO', { cwd: '~', env: { FOO: 'bar' } });
  assert(r.output === '/home/user\nbar\n', JSON.stringify(r));
  let streamed = '';
  await vm.exec('echo a; echo b', { onOutput: (t) => { streamed += t; } });
  assert(streamed === 'a\nb\n', streamed);
  const missing = await vm.exec('true', { cwd: '/nope' }).then(() => 'resolved', () => 'rejected');
  assert(missing === 'rejected', 'missing cwd must reject');
  const ac = new AbortController(), t = performance.now();
  setTimeout(() => ac.abort(), 300);
  await vm.exec('sleep 30', { signal: ac.signal }).catch(() => {});
  assert(performance.now() - t < 5000, 'abort did not stop the command');
  const t0 = performance.now(); for (let i = 0; i < 10; i++) await vm.exec('true');
  return { execMs: Math.round((performance.now() - t0) / 10) };
}));

await test('files: mkdir/stat/ls/~, text, binary, rename, remove, errors', () => inVM(async (vm, { assert }) => {
  await vm.mkdir('~/t/a/b');
  assert((await vm.stat('~/t/a')).type === 'dir');
  assert((await vm.stat('~/t/none')) === null);
  await vm.writeFile('~/t/ü.txt', 'grüße\n');
  await vm.writeFile('~/t/empty', '');
  assert((await vm.readText('~/t/ü.txt')) === 'grüße\n');
  assert((await vm.readText('~/t/empty')) === '');
  await vm.writeFile('~/t/ü.txt', 'x');
  assert((await vm.readText('~/t/ü.txt')) === 'x', 'overwrite');
  const bin = new Uint8Array(2 << 20).map((_, i) => (i * 7) & 255);
  await vm.writeFile('~/t/bin', bin);
  const back = await vm.readFile('~/t/bin');
  assert(back.length === bin.length && back.every((b, i) => b === bin[i]), 'binary round trip');
  await vm.exec('cd ~/t && ln -s a link && ln -s gone dangling && touch .hidden');
  const ls = await vm.ls('~/t');
  const by = Object.fromEntries(ls.map((e) => [e.name, e]));
  assert(ls.map((e) => e.name).join() === '.hidden,a,bin,dangling,empty,link,ü.txt', ls.map((e) => e.name).join());
  assert(by.link.type === 'link' && by.link.linkType === 'dir' && by.dangling.linkType === null, JSON.stringify([by.link, by.dangling]));
  assert(by.bin.size === bin.length && by.bin.mtime > Date.now() - 600000 && by.bin.mode === 0o644, JSON.stringify(by.bin));
  await vm.rename('~/t/a', '~/t/c');
  assert(!(await vm.stat('~/t/a')) && (await vm.stat('~/t/c/b')).type === 'dir', 'rename');
  await vm.remove('~/t/c');
  assert(!(await vm.stat('~/t/c')), 'remove');
  const err = await vm.readText('~/t/missing').catch((e) => e.code);
  assert(err === 'ENOENT', err);
  assert((await vm.ls('~/t/missing').catch((e) => e.code)) === 'ENOENT');
}));

await test('terminals: 8 at once, own cwd and size, resize, Ctrl-C, exit, large output and paste', () => inVM(async (vm, { assert, term }) => {
  await vm.mkdir('~/w');
  const all = await Promise.all(Array.from({ length: 8 }, (_, i) => term({ cols: 80 + i, rows: 24, cwd: i ? '~/w' : '/tmp' })));
  all.forEach((s, i) => s.write(`echo T$((${i}*1)) $(pwd) $(stty size)\r`));
  await Promise.all(all.map((s, i) => s.until(new RegExp(`T${i} ${i ? '/home/user/w' : '/tmp'} 24 ${80 + i}`))));
  const s = all[1];
  s.resize(100, 30); s.write('stty size\r'); await s.until(/30 100/);
  s.write('sleep 30\r'); await new Promise((r) => setTimeout(r, 300)); s.write('\x03'); s.write('echo after-$?\r'); await s.until(/after-130/);
  s.write('seq 1 50000 | tail -1\r'); await s.until(/\r50000\r\n/);
  const body = ('x'.repeat(99) + '\n').repeat(300);
  s.write("cat > ~/w/paste.txt\r"); s.write(body); s.write('\x04');
  for (let i = 0; i < 100 && ((await vm.stat('~/w/paste.txt')) || { size: 0 }).size < body.length; i++) await new Promise((r) => setTimeout(r, 100));
  assert((await vm.readText('~/w/paste.txt')) === body, 'paste');
  const code = await new Promise((r) => { all[2].onExit(r); all[2].write('exit 7\r'); });
  assert(code === 7, `exit code ${code}`);
  const closed = await new Promise((r) => { all[3].onExit(r); all[3].close(); });
  const cmd = await vm.openSession({ cmd: ['sh', '-c', 'echo $X; exit 4'], env: { X: 'cmd-env' } });
  let out = ''; cmd.onData((d) => { out += new TextDecoder().decode(d); });
  assert(await new Promise((r) => cmd.onExit(r)) === 4 && out.includes('cmd-env'), out);
  const fallback = await term({ cwd: '~/does-not-exist' }); fallback.write('pwd\r'); await fallback.until(/\/home\/user\r?\n/);
  all.forEach((t) => t.close());
  return { closedWith: closed };
}));

await test('git workflow and keystroke echo latency', () => inVM(async (vm, { assert, term }) => {
  const r = await vm.exec('mkdir -p ~/repo && cd ~/repo && git init -q && echo hi > README.md && git add . && git commit -qm first && git log --format="%an %s"');
  assert(r.code === 0 && r.output.includes('Student first'), r.output);
  const s = await term({ cwd: '~/repo' });
  s.write('git status --short; echo done\r'); await s.until(/done/);
  const t = performance.now(); s.write('z'); await s.until(/z$/);
  s.close();
  return { echoMs: Math.round(performance.now() - t) };
}));

await test('watch and activity follow terminal changes', () => inVM(async (vm, { assert, sleep, term }) => {
  await vm.mkdir('~/watched');
  let lists = 0, last = [], activity = 0;
  const off = vm.watch('~/watched', (e) => { lists++; last = e; });
  const offA = vm.on('activity', () => activity++);
  const s = await term({ cwd: '~/watched' });
  await sleep(500);
  s.write('touch new.txt\r');
  for (let i = 0; i < 40 && !last.some((e) => e.name === 'new.txt'); i++) await sleep(50);
  assert(last.some((e) => e.name === 'new.txt'), `watch did not fire: ${JSON.stringify(last)}`);
  assert(activity > 0, 'no activity event');
  off(); offA(); s.close();
  return { lists };
}));

const cache = `qos-test-${Date.now()}`;
await test('persist: files and setup survive a reload, reset clears them', async () => {
  const q = `persist&cache=${cache}&setup=${encodeURIComponent('echo run >> ~/setup-count')}`;
  await page.close();
  await open(q);
  await inVM(async (vm) => { await vm.writeFile('~/kept', 'yes'); await vm.exec('sudo apk info -e git >/dev/null; echo x | sudo tee /etc/edited >/dev/null'); await vm.save(); });
  await page.close();
  await open(q);
  const r = await inVM(async (vm, { assert }) => {
    assert((await vm.readText('~/kept')) === 'yes', 'home file lost');
    assert((await vm.readText('/etc/edited')) === 'x\n', 'root change lost');
    assert((await vm.readText('~/setup-count')) === 'run\n', 'setup ran again');
    return { readyMs: Math.round(await window.booted) };
  });
  await page.evaluate(() => { window.vm.reset(); });
  await page.waitForFunction(() => window.vm && window.vm.isReady, null, { timeout: 60000 });
  await inVM(async (vm, { assert }) => assert(!(await vm.stat('~/kept')), 'reset kept the file'));
  return r;
});

if (process.argv.includes('--network')) {
  await test('network: a missing command is installed on first use', async () => {
    await page.close();
    await open('network=1');
    return inVM(async (vm, { term }) => {
      const s = await term({}); s.write('jq --version\r'); await s.until(/jq-\d/, 60000); s.close();
    });
  });
}

console.log(`\n${passed}/${passed + failed} passed`);
await browser.close();
process.exit(failed ? 1 : 0);
