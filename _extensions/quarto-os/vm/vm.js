// Quarto OS: one shared Linux machine per page, powered by unkernel
// (https://github.com/pithings/unkernel), a Linux kernel compiled to WebAssembly.
// Terminals are guest ptys; file operations and exec() are guest programs.

import { ASSET_BASE } from '../apps/versions.js';

const HOME = '/home/user';
const ACTIVITY_DEBOUNCE = 300, ACTIVITY_MAX_WAIT = 1000, WATCH_POLL_MS = 3000;
const SIGNALS = { 1: 'SIGHUP', 2: 'SIGINT', 9: 'SIGKILL', 15: 'SIGTERM' };
const TYPES = { 'regular file': 'file', 'regular empty file': 'file', directory: 'dir', 'symbolic link': 'link' };
const ERRORS = [[/No such file/, 'ENOENT'], [/Not a directory/, 'ENOTDIR'], [/Is a directory/, 'EISDIR'],
  [/Permission denied/, 'EACCES'], [/File exists/, 'EEXIST'], [/not empty/, 'ENOTEMPTY']];
// ls: one line "type/size/mtime/mode/name" per entry; symlinks add "=target-type/name".
const LS = `cd -- "$1" || exit; shift
for f in * .[!.]* ..?*; do if [ -e "$f" ] || [ -L "$f" ]; then set -- "$@" "$f"; fi; done
[ $# = 0 ] || stat -c '%F/%s/%Y/%a/%n' -- "$@" || exit
for f; do if [ -L "$f" ]; then printf '=%s/%s\\n' "$(stat -L -c %F -- "$f" 2>/dev/null)" "$f"; fi; done`;

const dec = new TextDecoder();
const safe = (fn, ...a) => { try { fn(...a); } catch (e) { console.error('[quarto-os vm]', e); } };
const shellQuote = (a) => /^[\w@%+=:,./-]+$/.test(a) ? a : `'${String(a).replace(/'/g, `'\\''`)}'`;
const hidden = () => typeof document !== 'undefined' && document.hidden;
const hash = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193); return (h >>> 0).toString(16); };
const bytes = (d) => typeof d === 'string' ? d : d instanceof Uint8Array ? d : new Uint8Array(ArrayBuffer.isView(d) ? d.buffer : d);
const ended = (e) => e.type === 'exit' ? e.code : e.type === 'signal' ? 128 + e.signal : -1;

function fail(what, stderr) {
  const msg = String(stderr).trim().split('\n').pop() || 'failed';
  const e = new Error(`${what}: ${msg}`);
  e.code = (ERRORS.find(([re]) => re.test(msg)) || [0, 'EIO'])[1];
  return e;
}

class Session {
  constructor(vm, pty) {
    Object.assign(this, { vm, pty, pid: pty.pid, cols: pty.cols, rows: pty.rows, exited: false, exitCode: null, convertEol: false });
    this._data = new Set(); this._exit = new Set(); this._early = [];
    (async () => { for await (const chunk of pty.output) this._push(chunk); })().catch(() => {});
    pty.ended.then(ended, () => -1).then((code) => this._end(code));
  }
  write(data) { if (!this.exited) this.pty.write(bytes(data)).catch(() => {}); }
  resize(cols, rows) {
    this.cols = Math.max(1, cols | 0); this.rows = Math.max(1, rows | 0);
    if (!this.exited) this.pty.resize(this.cols, this.rows);
  }
  /** cb(Uint8Array) for every chunk of output. Returns an unsubscribe function. */
  onData(cb) {
    this._data.add(cb);
    if (this._early) { const early = this._early; this._early = null; for (const c of early) safe(cb, c); }
    return () => this._data.delete(cb);
  }
  /** cb(code) once the shell exits (exit status, 128+signal, -1 if the connection was lost). */
  onExit(cb) {
    if (this.exited) queueMicrotask(() => cb(this.exitCode)); else this._exit.add(cb);
    return () => this._exit.delete(cb);
  }
  kill(sig = 15) { if (!this.exited) this.pty.kill(SIGNALS[sig] || String(sig)); }
  close() { if (!this.exited) this.pty.close().catch(() => {}); }
  _push(chunk) {
    if (this._early) this._early.push(chunk); else for (const cb of this._data) safe(cb, chunk);
    this.vm._activity();
  }
  _end(code) {
    if (this.exited) return;
    Object.assign(this, { exited: true, exitCode: code });
    for (const cb of this._exit) safe(cb, code);
    this._exit.clear();
    this.vm._activity();
  }
}

class VM {
  constructor(config = {}) {
    const pick = (camel, kebab, dflt) => config[camel] ?? config[kebab] ?? dflt;
    const bool = (v) => v === true || v === 'true';
    const network = pick('network', 'network', true);
    this.config = {
      assetBase: String(pick('assetBase', 'asset-base', ASSET_BASE)),
      memory: Number(pick('memory', 'memory', 512)),
      bootTimeout: Number(pick('bootTimeout', 'boot-timeout', 120000)),
      persist: bool(pick('persist', 'persist', false)),
      cacheId: String(pick('cacheId', 'cache-id', 'quarto-os')),
      setup: String(pick('setup', 'setup', '') || ''),
      network: network === false || network === 'false' ? false : network,
    };
    if (!Number.isInteger(this.config.memory) || this.config.memory < 128 || this.config.memory > 2048)
      throw new Error('VM memory must be an integer between 128 and 2048 MiB');
    this._assets = new URL(this.config.assetBase.replace(/\/?$/, '/'), document.baseURI);
    this.home = HOME;
    this.status = '';
    this.isReady = false;
    this._listeners = { status: new Set(), activity: new Set() };
    this._act = { timer: 0, first: 0, last: 0 };
    this._watches = new Map();
    this.ready = this._boot().then(
      () => { this.isReady = true; this._setStatus('Ready'); },
      (e) => { this._setStatus('Error: ' + e.message); throw e; });
    this.ready.catch(() => {}); // callers that never await ready don't get an unhandled rejection
  }

  // --- events -------------------------------------------------------------

  /** on('status', cb(msg)) | on('activity', cb()). Returns an unsubscribe function. */
  on(evt, cb) {
    const set = this._listeners[evt];
    if (!set) throw new Error(`Unknown VM event "${evt}"`);
    set.add(cb);
    if (evt === 'status' && !this.isReady && this.status) safe(cb, this.status);
    return () => set.delete(cb);
  }
  off(evt, cb) { this._listeners[evt]?.delete(cb); }
  _setStatus(msg) { this.status = msg; for (const cb of this._listeners.status) safe(cb, msg); }

  // Debounced 'activity': 300 ms after the last trigger, at least every second.
  _activity() {
    const a = this._act;
    a.last = performance.now();
    if (!a.first) a.first = a.last;
    if (!a.timer) a.timer = setTimeout(this._actFire, ACTIVITY_DEBOUNCE);
  }
  _actFire = () => {
    const a = this._act, now = performance.now();
    const due = Math.min(a.last + ACTIVITY_DEBOUNCE, a.first + ACTIVITY_MAX_WAIT);
    if (due - now > 1) { a.timer = setTimeout(this._actFire, due - now); return; }
    a.timer = 0; a.first = 0;
    for (const cb of this._listeners.activity) safe(cb);
    this._pollWatches();
  };

  // --- boot ---------------------------------------------------------------

  async _boot() {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Linux VM boot timed out')), this.config.bootTimeout); });
    try { await Promise.race([this._start(), timeout]); } finally { clearTimeout(timer); }
  }

  async _start() {
    this._setStatus('Loading Linux…');
    const asset = (name) => new URL(name, this._assets).href;
    const get = async (url, opts) => {
      const r = await fetch(url, opts);
      if (!r.ok) throw new Error(`Could not load VM asset ${url} (HTTP ${r.status})`);
      return r;
    };
    // Download the kernel while the runtime and manifest load.
    const kernel = get(asset('unkernel/unkernel.wasm.gz')).then((r) => new Response(
      r.body.pipeThrough(new DecompressionStream('gzip')), { headers: { 'content-type': 'application/wasm' } }));
    kernel.catch(() => {});
    const [uk, manifest] = await Promise.all([
      import(asset('unkernel/web.mjs')),
      get(asset('manifest.json'), { cache: 'no-cache' }).then((r) => r.json()),
    ]);
    const support = await uk.checkSupport();
    if (!support.ok) throw new Error(`This browser cannot run the Linux VM (${support.problems.join('; ')}); use Chrome or Edge 137+, Firefox 153+ or Safari 27+`);
    const { network, persist, cacheId } = this.config;
    let disks;
    if (persist) { // the first tab keeps changes, others get a temporary copy
      const owner = await new Promise((resolve) => navigator.locks.request(`quarto-os:${cacheId}`, { ifAvailable: true },
        (lock) => { resolve(!!lock); return lock && new Promise(() => {}); }));
      disks = [{ kind: 'data', template: 'bundled', name: cacheId, mode: owner ? 'persistent' : 'snapshot' }];
    }
    this._setStatus('Booting Linux…');
    this._k = await uk.createKernel({
      kernel: await kernel, distro: asset(manifest.image), memoryMiB: this.config.memory, disks,
      net: network && { kind: 'net', backend: { kind: 'wisp', servers: network === true ? uk.DEFAULT_WISP_SERVERS : network } },
      log: (m) => console.debug('[quarto-os vm]', m),
    });
    this._k.exited.then((e) => { if (this.isReady) this._setStatus(`Linux stopped (${e.reason || e.kind || 'exit'})`); });
    await this._k.exec('/bin/true');
    // Fetch git's files in the background, so the first git command is quick.
    this._k.exec('/bin/sh', ['-c', 'cd /tmp && git init -q .qos-warm && git -C .qos-warm status; rm -rf .qos-warm']).catch(() => {});
    await this._runSetup();
    if (persist) addEventListener('pagehide', () => this.save());
  }

  async _runSetup() {
    const script = this.config.setup;
    if (!script.trim()) return;
    const marker = `${HOME}/.cache/quarto-os/setup-${hash(script)}`;
    if (await this._stat(marker)) return; // persisted VM: already done
    this._setStatus('Running setup script…');
    let partial = '';
    const onOutput = (text) => {
      const lines = (partial + text).split(/\r?\n/);
      partial = lines.pop();
      for (const l of lines) { console.log('[quarto-os setup]', l); this._setStatus(l); }
    };
    const r = await this._exec(script, { cwd: HOME, onOutput, shell: '/bin/bash' });
    if (r.code === 0) await this._exec(`mkdir -p ~/.cache/quarto-os && date > ${marker}`);
    else { console.warn(`[quarto-os vm] setup script failed (exit ${r.code})`); this._setStatus(`Setup script failed (exit ${r.code})`); }
  }

  // --- internal operations (usable before `ready`, e.g. by setup) ----------

  _path(p) {
    p = p == null || p === '' ? '~' : String(p);
    return p === '~' ? HOME : p.startsWith('~/') ? HOME + p.slice(1) : p;
  }

  async _run(what, file, args, opts = {}) {
    const r = await this._k.exec(file, args, opts);
    if (r.exitCode !== 0) throw fail(what, opts.encoding ? dec.decode(r.stderr) : r.stderr);
    return r.stdout;
  }

  async _change(what, file, args, opts) { await this._run(what, file, args, opts); this._activity(); }

  async _stat(path) {
    const p = this._path(path);
    const r = await this._k.exec('stat', ['-L', '-c', '%F/%s/%Y/%a', '--', p]);
    if (r.exitCode !== 0) {
      const e = fail(`stat ${p}`, r.stderr);
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
      throw e;
    }
    const [type, size, mtime, mode] = r.stdout.trim().split('/');
    return { type: TYPES[type] || 'other', size: +size, mtime: mtime * 1000, mode: parseInt(mode, 8) };
  }

  async _exec(cmd, { cwd, env, onOutput, signal, shell = '/bin/sh' } = {}) {
    const p = await this._k.spawn(shell, ['-c', `exec 2>&1\n${cmd}`], { pty: false, cwd: this._path(cwd), env });
    const kill = () => p.kill('SIGKILL');
    signal?.addEventListener('abort', kill, { once: true });
    p.stdin.close().catch(() => {});
    p.stderr.cancel().catch(() => {});
    const chunks = [], td = new TextDecoder();
    for await (const c of p.stdout) { chunks.push(c); if (onOutput) onOutput(td.decode(c, { stream: true })); }
    const code = await p.ended.then(ended, () => -1);
    signal?.removeEventListener('abort', kill);
    this._activity();
    return { code, output: dec.decode(new Uint8Array(await new Blob(chunks).arrayBuffer())) };
  }

  // --- public API ---------------------------------------------------------

  /** Opens a terminal running `bash -l` (or `bash -lc cmd`; cmd may be an argv array). opts: {cols, rows, cwd, cmd, env}. */
  async openSession({ cols = 80, rows = 24, cwd, cmd, env } = {}) {
    await this.ready;
    if (Array.isArray(cmd)) cmd = cmd.map(shellQuote).join(' ');
    const dir = this._path(cwd);
    const opts = { cols: Math.max(1, cols | 0) || 80, rows: Math.max(1, rows | 0) || 24, cwd: dir, env, term: 'xterm-256color' };
    const args = cmd ? ['-lc', cmd] : ['-l'];
    if (dir !== HOME && !(await this._stat(dir))) opts.cwd = HOME; // a missing cwd falls back to ~
    return new Session(this, await this._k.spawn('/bin/bash', args, opts));
  }

  /** Lists a directory (no . and ..), sorted by name: [{name, type, size, mtime, mode, linkType?}]. */
  async ls(path) {
    await this.ready;
    const p = this._path(path);
    const out = new Map();
    for (const line of (await this._run(`ls ${p}`, '/bin/sh', ['-c', LS, 'ls', p])).split('\n')) {
      if (line.startsWith('=')) {
        const [type, ...name] = line.slice(1).split('/');
        const e = out.get(name.join('/'));
        if (e) e.linkType = TYPES[type] || (type ? 'other' : null);
      } else if (line) {
        const [type, size, mtime, mode, ...name] = line.split('/');
        out.set(name.join('/'), { name: name.join('/'), type: TYPES[type] || 'other', size: +size, mtime: mtime * 1000, mode: parseInt(mode, 8) });
      }
    }
    return [...out.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** {type, size, mtime, mode} following symlinks, or null if it does not exist. */
  async stat(path) { await this.ready; return this._stat(path); }

  async readFile(path) {
    await this.ready;
    const p = this._path(path);
    return this._run(`read ${p}`, 'cat', ['--', p], { encoding: 'buffer' });
  }

  async readText(path) { return dec.decode(await this.readFile(path)); }

  /** Writes (creates/truncates) a file. data: string | Uint8Array | ArrayBuffer. */
  async writeFile(path, data) {
    await this.ready;
    const p = this._path(path);
    await this._change(`write ${p}`, '/bin/sh', ['-c', 'cat > "$1"', 'sh', p], { input: bytes(data ?? '') });
  }

  /** Runs `sh -c cmd` as user; resolves {code, output} (stdout+stderr merged).
   *  Extra opts: cwd, env, onOutput(text) for streaming, signal (AbortSignal → SIGKILL). */
  async exec(cmd, opts = {}) { await this.ready; return this._exec(cmd, opts); }

  /** mkdir -p */
  async mkdir(path) { await this.ready; const p = this._path(path); await this._change(`mkdir ${p}`, 'mkdir', ['-p', '--', p]); }

  /** rm -r (a missing path is not an error; refuses "/"). */
  async remove(path) {
    await this.ready;
    const p = this._path(path);
    if (p.replace(/\/+$/, '') === '') throw new Error('Refusing to remove /');
    await this._change(`remove ${p}`, 'rm', ['-rf', '--', p]);
  }

  async rename(from, to) {
    await this.ready;
    const a = this._path(from), b = this._path(to);
    await this._change(`rename ${a} → ${b}`, 'mv', ['-T', '--', a, b]);
  }

  /**
   * Calls cb(entries, error) with the listing of dir now and whenever it
   * changes. Polls: quickly after 'activity', every 3 s otherwise, never while
   * the page is hidden. Returns an unsubscribe function.
   */
  watch(dir, cb) {
    const path = this._path(dir);
    let w = this._watches.get(path);
    if (!w) this._watches.set(path, w = { path, cbs: new Set(), entries: null, sig: null, busy: false, again: false });
    w.cbs.add(cb);
    if (w.entries) queueMicrotask(() => w.cbs.has(cb) && safe(cb, w.entries, w.error));
    else this._pollWatch(w);
    if (!this._watchTimer) this._watchTimer = setInterval(() => this._pollWatches(), WATCH_POLL_MS);
    return () => {
      w.cbs.delete(cb);
      if (!w.cbs.size && this._watches.get(path) === w) this._watches.delete(path);
      if (!this._watches.size) { clearInterval(this._watchTimer); this._watchTimer = 0; }
    };
  }

  _pollWatches() { if (!hidden()) for (const w of this._watches.values()) this._pollWatch(w); }

  async _pollWatch(w) {
    if (w.busy) { w.again = true; return; }
    w.busy = true;
    try {
      do {
        w.again = false;
        let entries = [], error = null;
        try { entries = await this.ls(w.path); } catch (e) { error = e; }
        const sig = error ? `!${error.code}` : entries.map((e) => `${e.name}/${e.type}/${e.size}/${e.mtime}/${e.mode}`).join('\0');
        if (sig !== w.sig) {
          Object.assign(w, { sig, entries, error });
          for (const cb of w.cbs) safe(cb, entries, error);
        }
      } while (w.again && w.cbs.size);
    } finally { w.busy = false; }
  }

  /** With persist: flushes the guest's file changes to IndexedDB now (it also does so about every second). */
  async save() {
    await this.ready;
    return this.config.persist ? this._k.sync() : false;
  }

  /** Deletes the persisted changes and reloads from the pristine guest image. */
  async reset() {
    await this._k?.stop();
    await new Promise((resolve) => { const r = indexedDB.deleteDatabase(`kwdisk:${this.config.cacheId}-v1`); r.onsuccess = r.onerror = r.onblocked = resolve; });
    location.reload();
  }
}

/** Creates the shared machine; await vm.ready before using it. */
export async function createVM(config) {
  return new VM(config);
}
