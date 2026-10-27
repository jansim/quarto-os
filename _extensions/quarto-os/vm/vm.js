// Quarto OS: one shared v86 Linux machine per page.
// The unprivileged qos-agent multiplexes filesystem requests and six Linux PTYs
// over a raw serial console. v86 is BSD-2-Clause licensed and needs no COOP/COEP.

import {sha256Hex} from './sha256.js';

const V86_VERSION = '0.5.472';
const DEFAULT_ASSETS = 'https://jansim.github.io/quarto-os/vm-assets/';
const HOME = '/home/user';
const VT_FIRST = 2, VT_LAST = 7; // logical session slots, kept for API compatibility
const LINE_RAW = 600;
const BULK_WRITE = 64 * 1024;
const ACTIVITY_DEBOUNCE = 300, ACTIVITY_MAX_WAIT = 1000, WATCH_POLL_MS = 3000;

// errno numbers of i386 Linux → names (Error#code).
const ERRNO = {
  1: 'EPERM', 2: 'ENOENT', 5: 'EIO', 9: 'EBADF', 11: 'EAGAIN', 12: 'ENOMEM', 13: 'EACCES',
  16: 'EBUSY', 17: 'EEXIST', 18: 'EXDEV', 20: 'ENOTDIR', 21: 'EISDIR', 22: 'EINVAL',
  26: 'ETXTBSY', 27: 'EFBIG', 28: 'ENOSPC', 30: 'EROFS', 36: 'ENAMETOOLONG', 38: 'ENOSYS',
  39: 'ENOTEMPTY', 40: 'ELOOP',
};
const TYPES = { f: 'file', d: 'dir', l: 'link', o: 'other' };

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------------------------------------------------------------------------
// base64 helpers (decode works directly on console bytes: no string detour)
// ---------------------------------------------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64REV = new Uint8Array(256).fill(255);
for (let i = 0; i < 64; i++) B64REV[B64.charCodeAt(i)] = i;

function b64decode(b, s, e) {
  const out = new Uint8Array(((e - s) * 3) >> 2);
  let o = 0, v = 0, bits = 0;
  for (let i = s; i < e; i++) {
    const c = B64REV[b[i]];
    if (c === 255) continue; // padding / stray bytes
    v = ((v << 6) | c) & 0xffffff;
    bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (v >> bits) & 255; }
  }
  return o === out.length ? out : out.subarray(0, o);
}

function b64encode(u8, s, e) {
  return btoa(String.fromCharCode.apply(null, u8.subarray(s, e)));
}

function concat(chunks, size) {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

function toBytes(data) {
  if (typeof data === 'string') return enc.encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return enc.encode(String(data ?? ''));
}

// NUL-joined request body.
function fields(list) {
  const parts = list.map(toBytes);
  let n = parts.length - 1;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(Math.max(n, 0));
  let o = 0;
  parts.forEach((p, i) => { if (i) out[o++] = 0; out.set(p, o); o += p.length; });
  return out;
}

const envFields = (env) => Object.entries(env || {}).map(([k, v]) => `${k}=${v}`);
const shellQuote = (a) => /^[\w@%+=:,./-]+$/.test(a) ? a : `'${String(a).replace(/'/g, `'\\''`)}'`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hidden = () => typeof document !== 'undefined' && document.hidden;
const safe = (fn, ...a) => { try { fn(...a); } catch (e) { console.error('[quarto-os vm]', e); } };

function hash(str) { // FNV-1a, 32 bit
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

// "t/size/mtime/mode/name" → entry
function parseRecord(r) {
  const a = r.indexOf('/'), b = r.indexOf('/', a + 1), c = r.indexOf('/', b + 1), d = r.indexOf('/', c + 1);
  const t = r.slice(0, a);
  const e = {
    name: r.slice(d + 1),
    type: TYPES[t[0]] || 'other',
    size: +r.slice(a + 1, b),
    mtime: +r.slice(b + 1, c),         // milliseconds since the epoch
    mode: parseInt(r.slice(c + 1, d), 8),
  };
  if (t[0] === 'l') e.linkType = TYPES[t[1]] || null; // null: dangling link
  return e;
}

class Session {
  constructor(vm, id, vt, cols, rows) {
    this.vm = vm;
    this.id = id;
    this.vt = vt;            // logical slot; Linux allocates /dev/pts/<n>
    this.pid = 0;
    this.cols = cols;
    this.rows = rows;
    this.exited = false;
    this.exitCode = null;
    this.convertEol = false; // Linux PTYs apply their own termios output translation.
    this._data = new Set();
    this._exit = new Set();
    this._early = [];        // output that arrived before the first onData()
    this._prevCR = false;
    this._rz = 0;
  }

  /** Writes bytes to this shell's PTY; the kernel handles Ctrl-C and job control. */
  write(data) {
    if (!this.exited) this.vm._writeSession(this, toBytes(data));
  }

  resize(cols, rows) {
    this.cols = Math.max(1, cols | 0);
    this.rows = Math.max(1, rows | 0);
    if (!this.exited && this.pid) this.vm._line(`\x02Z ${this.id} ${this.cols} ${this.rows}`);
  }

  activate() { if (!this.exited) this.vm._active = this; }

  /** cb(Uint8Array) for every chunk of output. Returns an unsubscribe function. */
  onData(cb) {
    this._data.add(cb);
    if (this._early) {
      const early = this._early;
      this._early = null;
      for (const chunk of early) safe(cb, chunk);
    }
    return () => this._data.delete(cb);
  }

  /** cb(code) once the shell exits (exit status, 128+signal, -1 if the VM agent died). */
  onExit(cb) {
    if (this.exited) queueMicrotask(() => cb(this.exitCode));
    else this._exit.add(cb);
    return () => this._exit.delete(cb);
  }

  /** Sends a signal (number, default SIGTERM) to every process of the session. */
  kill(sig = 15) { if (!this.exited) this.vm._line(`\x02K ${this.id} ${sig | 0}`); }

  /** Hangs up the session (SIGHUP, then SIGKILL); onExit fires when it is gone. */
  close() { if (!this.exited) this.vm._line(`\x02C ${this.id}`); }

  _push(u8) {
    let out = u8;
    if (this.convertEol) {
      let extra = 0, prev = this._prevCR;
      for (let i = 0; i < u8.length; i++) { const b = u8[i]; if (b === 10 && !prev) extra++; prev = b === 13; }
      if (extra) {
        out = new Uint8Array(u8.length + extra);
        let o = 0;
        prev = this._prevCR;
        for (let i = 0; i < u8.length; i++) {
          const b = u8[i];
          if (b === 10 && !prev) out[o++] = 13;
          out[o++] = b;
          prev = b === 13;
        }
      }
      this._prevCR = u8[u8.length - 1] === 13;
    }
    if (out === u8) out = u8.slice(); // never hand out a shared console buffer
    if (this._early) this._early.push(out);
    else for (const cb of this._data) safe(cb, out);
  }

  _end(code) {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    clearTimeout(this._rz);
    for (const cb of this._exit) safe(cb, code);
    this._exit.clear();
  }
}

// ---------------------------------------------------------------------------
// VM
// ---------------------------------------------------------------------------

class VM {
  constructor(config, baseUrl) {
    const c = config || {};
    if (c.disk != null || c.diskType != null || c['disk-type'] != null || c.cheerpx != null)
      throw new Error('CheerpX disk options are no longer supported; build v86 assets and set vm.asset-base');
    const pick = (camel, kebab, dflt) => c[camel] ?? c[kebab] ?? dflt;
    const bool = (v) => v === true || v === 'true';
    this.config = {
      assetBase: String(pick('assetBase', 'asset-base', DEFAULT_ASSETS)),
      memory: Number(pick('memory', 'memory', 512)),
      bootSnapshot: bool(pick('bootSnapshot', 'boot-snapshot', true)),
      bootTimeout: Number(pick('bootTimeout', 'boot-timeout', 120000)),
      persist: bool(pick('persist', 'persist', false)),
      cacheId: String(pick('cacheId', 'cache-id', 'quarto-os')),
      setup: pick('setup', 'setup', ''),
    };
    if (!Number.isInteger(this.config.memory) || this.config.memory < 256 || this.config.memory > 2048)
      throw new Error('VM memory must be an integer between 256 and 2048 MiB');
    if (!Number.isFinite(this.config.bootTimeout) || this.config.bootTimeout <= 0)
      throw new Error('VM boot-timeout must be a positive number of milliseconds');
    this._assets = new URL(this.config.assetBase.replace(/\/?$/, '/'), document.baseURI);
    this.home = HOME;
    this.status = '';
    this.isReady = false;
    this.maxSessions = VT_LAST - VT_FIRST + 1;
    this._agentUrl = baseUrl
      ? String(baseUrl).replace(/\/?$/, '/') + 'vm/qos-agent'
      : new URL('qos-agent', import.meta.url).href;

    this._listeners = { status: new Set(), activity: new Set() };
    this._pending = new Map();   // request id → {resolve, reject, chunks, size, onData, what}
    this._sessions = new Map();  // session id → Session
    this._vts = new Map();       // vt number → Session
    this._active = null;         // session whose size the VTs currently have
    this._nextId = 1;
    this._q = [];                // outgoing agent lines (FIFO, keeps request order)
    this._up = false;            // agent said hello and is accepting lines
    this._upWaiters = [];
    this._fb = new Uint8Array(1 << 16); // partial frame across console chunks
    this._fl = 0;
    this._inFrame = false;
    this._stray = '';
    this._act = { timer: 0, first: 0, last: 0 };
    this._watches = new Map();
    this._watchTimer = 0;
    this._bulkSeq = 0;
    this._bulkWrite = BULK_WRITE;
    this._firstSession = true;

    this.ready = this._boot().then(
      () => { this.isReady = true; this._setStatus('Ready'); },
      (e) => { this._setStatus('Error: ' + e.message); throw e; });
    this.ready.catch(() => {}); // callers that never await ready don't get an unhandled rejection
  }

  // --- events -------------------------------------------------------------

  /**
   * on('status', cb(msg)) | on('activity', cb()). Returns an unsubscribe
   * function. A status listener added while the VM is still booting (or after
   * boot failed) is called right away with the current message.
   */
  on(evt, cb) {
    const set = this._listeners[evt];
    if (!set) throw new Error(`Unknown VM event "${evt}"`);
    set.add(cb);
    if (evt === 'status' && !this.isReady && this.status) safe(cb, this.status);
    return () => set.delete(cb);
  }
  off(evt, cb) { this._listeners[evt]?.delete(cb); }

  _setStatus(msg) {
    this.status = msg;
    for (const cb of this._listeners.status) safe(cb, msg);
  }

  // Debounced 'activity': 300 ms after the last trigger, at least every
  // second while triggers keep coming. One timer, re-armed only when it fires
  // (this runs for every chunk of terminal output).
  _activity() {
    if (this.config.persist && this.isReady && !this._saving) this._scheduleSave();
    if (!this._listeners.activity.size && !this._watches.size) return;
    const a = this._act;
    a.last = performance.now();
    if (!a.first) a.first = a.last;
    if (!a.timer) a.timer = setTimeout(this._actFire, ACTIVITY_DEBOUNCE);
  }

  _actFire = () => {
    const a = this._act, now = performance.now();
    const due = Math.min(a.last + ACTIVITY_DEBOUNCE, a.first + ACTIVITY_MAX_WAIT);
    if (due - now > 1) { a.timer = setTimeout(this._actFire, due - now); return; }
    a.timer = 0;
    a.first = 0;
    for (const cb of this._listeners.activity) safe(cb);
    this._pollWatches();
  };

  // --- boot ---------------------------------------------------------------

  async _boot() {
    let timer;
    try {
      await Promise.race([
        this._startMachine(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Linux VM boot timed out')), this.config.bootTimeout); }),
      ]);
    } catch (error) {
      this._stopped = true;
      this._emulator?.destroy();
      this._agentDown(error);
      throw error;
    } finally { clearTimeout(timer); }
  }

  async _startMachine() {
    this._setStatus('Loading v86…');
    const asset = name => new URL(name, this._assets).href;
    const get = async (url, type, cache = 'no-cache') => {
      const response = await fetch(url, {cache});
      if (!response.ok) throw new Error(`Could not load VM asset ${url} (HTTP ${response.status})`);
      return response[type]();
    };
    const [manifest, agent] = await Promise.all([
      get(asset('manifest.json'), 'json'), get(this._agentUrl, 'arrayBuffer'),
    ]);
    if (manifest.runtime !== V86_VERSION || !manifest.image) throw new Error('Incompatible v86 asset manifest; rebuild the VM assets');
    const agentHash = await sha256Hex(agent);
    this._signature = `${V86_VERSION}/${manifest.image}/${agentHash}/${this.config.memory}/protocol-3`;
    let snapshot = null, userSnapshot = false;
    if (this.config.persist) {
      this._db = await openStore(this.config.cacheId);
      const saved = await storeRequest(this._db, 'readonly', store => store.get('machine'));
      if (saved?.signature === this._signature) {
        this._setStatus('Restoring Linux…');
        snapshot = await new Response(saved.state.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
        userSnapshot = true;
      }
    }
    const rooted = !!manifest.filesystem;
    if (rooted && (!manifest.filesystem.metadata || !manifest.filesystem.base))
      throw new Error('Incomplete on-demand filesystem manifest; rebuild the VM assets');
    if (!snapshot && this.config.bootSnapshot && manifest.bootState) {
      if (manifest.bootState.memory !== this.config.memory)
        throw new Error('Boot snapshot memory does not match vm.memory; use matching memory or set vm.boot-snapshot: false');
      this._setStatus('Loading clean boot snapshot…');
      const bytes = await get(asset(manifest.bootState.file), 'arrayBuffer', 'force-cache');
      if (await sha256Hex(bytes) !== manifest.bootState.sha256) throw new Error('Boot snapshot checksum mismatch');
      snapshot = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    }
    this.bootMode = userSnapshot ? 'persisted' : snapshot ? 'snapshot' : 'kernel';
    await loadRuntime(asset('libv86.js'));
    if (this._stopped) return;
    const emulator = this._emulator = new globalThis.V86({
      wasm_path: asset('v86.wasm'), bios: {url: asset('seabios.bin')},
      vga_bios: {url: asset('vgabios.bin')}, memory_size: this.config.memory * 1024 * 1024,
      filesystem: rooted ? {
        baseurl: asset(manifest.filesystem.base),
        ...(!snapshot ? {basefs: asset(manifest.filesystem.metadata)} : {}),
      } : {}, autostart: false, disable_keyboard: true, disable_mouse: true, disable_speaker: true,
      ...(snapshot ? {initial_state: {buffer: snapshot}} : {
        bzimage: {url: asset('bzimage')}, initrd: {url: asset('initrd.gz')},
        cmdline: 'console=ttyS0 tsc=reliable mitigations=off random.trust_cpu=on init=/init',
      }),
    });
    this._dataDev = {writeFile: async (name, bytes) => {
      if (this._checkpointing) await this._capturing;
      await emulator.create_file((rooted ? 'data/' : '') + name.replace(/^\//, ''), bytes);
    }};
    this._sendText = text => emulator.serial0_send(text);
    this._fsReads = 0;
    emulator.add_listener('9p-read-start', () => this._fsReads++);
    emulator.add_listener('9p-read-end', () => this._fsReads--);
    const bootstrap = async () => {
      await emulator.create_file((rooted ? 'data/' : '') + 'qos-agent', new Uint8Array(agent));
      // A published clean snapshot may have been built long before this visit.
      // Synchronize the guest clock while the bootstrap shell is still root.
      this._sendText(`/bin/busybox date -u -s @${Math.floor(Date.now() / 1000)} >/dev/null && cp /mnt/host/qos-agent /tmp/qos-agent && chmod 755 /tmp/qos-agent && /tmp/qos-agent; printf "\\nQOS_AGENT_STOPPED\\n"\n`);
    };
    let bootText = '', bootstrapped = !!snapshot;
    this._bootLog = '';
    let serial = [], scheduled = false;
    emulator.add_listener('serial0-output-byte', byte => {
      if (!this._up) this._bootLog = (this._bootLog + String.fromCharCode(byte)).slice(-4096);
      bootText = (bootText + String.fromCharCode(byte)).slice(-512);
      if (/\r?\nQOS_AGENT_STOPPED\r?\n/.test(bootText) || bootText.includes('Kernel panic - not syncing:')) {
        const error = new Error(bootText.includes('Kernel panic') ? 'Linux guest kernel panic during boot' : 'The Linux VM agent stopped');
        this._agentDown(error);
        for (const waiter of this._upWaiters.splice(0)) waiter.reject(error);
        this._setStatus('Error: ' + error.message);
        this.isReady = false;
        this._stopped = true;
        emulator.destroy();
        return;
      }
      serial.push(byte);
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(() => {
          const bytes = new Uint8Array(serial); serial = []; scheduled = false;
          this._onConsole(bytes, 1);
        });
      }
      if (!bootstrapped) {
        if (bootText.includes('QOS_READY#')) {
          bootstrapped = true;
          bootstrap().catch(error => { for (const waiter of this._upWaiters.splice(0)) waiter.reject(error); });
        }
      }
    });
    const ready = new Promise(resolve => emulator.add_listener('emulator-ready', resolve));
    const up = this._waitUp();
    await ready;
    if (this._stopped) return;
    this._setStatus(snapshot ? 'Restoring Linux…' : 'Booting Linux…');
    await emulator.run();
    if (userSnapshot) this._sendText('\x02B 2147483647\n');
    else if (snapshot) await bootstrap();
    await up;
    await this._ensureDefaults();
    await this._runSetup();
    if (this.config.persist) {
      this._scheduleSave();
      this._onPageHide = () => { this.save().catch(error => console.warn('[quarto-os vm] save failed', error)); };
      globalThis.addEventListener('pagehide', this._onPageHide);
    }
  }

  _scheduleSave() {
    if (this._resetting || this._stopped) return;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.save().catch(error => {
      console.warn('[quarto-os vm] save failed', error);
      this._setStatus('Could not save VM changes: ' + error.message);
    }), 2000);
  }

  /** Atomically checkpoints the full machine, including mutable 9p files. */
  async save() {
    await this.ready;
    if (!this.config.persist) return false;
    if (this._saving) return this._saving;
    this._saving = this._save();
    try { return await this._saving; } finally { this._saving = null; }
  }

  async _save() {
    clearTimeout(this._saveTimer);
    const deadline = performance.now() + 10000;
    while (this._pending.size || this._q.length || !this._credit || this._fsReads) {
      if (performance.now() > deadline) throw new Error('Cannot checkpoint while VM requests are active; wait for them to finish');
      await sleep(25);
    }
    this._checkpointing = true;
    let release;
    this._capturing = new Promise(resolve => { release = resolve; });
    let state;
    try {
      await this._emulator.stop();
      while (this._fsReads) {
        if (performance.now() > deadline) throw new Error('Filesystem reads did not finish before checkpoint');
        await sleep(10);
      }
      state = await this._emulator.save_state();
    } finally {
      await this._emulator.run();
      this._checkpointing = false; release(); this._pump();
    }
    const compressed = await new Response(new Blob([state]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
    await storeRequest(this._db, 'readwrite', store => store.put({signature: this._signature, state: compressed}, 'machine'));
    return true;
  }

  _waitUp() {
    if (this._up) return Promise.resolve();
    return new Promise((resolve, reject) => this._upWaiters.push({ resolve, reject }));
  }

  _onHello() {
    this._hello = true;
    this._up = true;
    this._credit = true;
    for (const w of this._upWaiters.splice(0)) w.resolve();
    this._pump();
  }

  _agentDown(err) {
    this._failure = err;
    this._up = false;
    this._q.length = 0;
    this._fl = 0; this._inFrame = false;
    for (const p of this._pending.values()) p.reject(err);
    this._pending.clear();
    for (const s of this._sessions.values()) s._end(-1);
    this._sessions.clear();
    this._vts.clear();
  }

  // VM defaults, applied on every boot but only where missing: a git
  // identity (so `git commit` works out of the box; `setup` may override it)
  // and a hostname in the bash prompt.
  async _ensureDefaults() {
    const gitconfig = `${HOME}/.gitconfig`;
    const git = await this._readText(gitconfig).catch(() => '');
    const missing = [];
    if (!/^\s*name\s*=/m.test(git)) missing.push('\tname = Student');
    if (!/^\s*email\s*=/m.test(git)) missing.push('\temail = student@example.com');
    if (missing.length) {
      await this._writeFile(gitconfig, `${git && !git.endsWith('\n') ? '\n' : ''}[user]\n${missing.join('\n')}\n`, true);
    }

  }

  async _runSetup() {
    const script = String(this.config.setup || '');
    if (!script.trim()) return;
    const h = hash(script);
    const marker = `${HOME}/.cache/quarto-os/setup-${h}`;
    if (await this._stat(marker)) return; // persisted VM: already done
    this._setStatus('Running setup script…');
    const file = `/tmp/qos-setup-${h}.sh`;
    await this._writeFile(file, script);
    let partial = '';
    const onOutput = (text) => {
      const lines = (partial + text).split(/\r?\n/);
      partial = lines.pop();
      for (const l of lines) { console.log('[quarto-os setup]', l); this._setStatus(l); }
    };
    const r = await this._exec(`bash ${file}`, { cwd: HOME, onOutput });
    if (partial) onOutput('\n');
    if (r.code === 0) {
      await this._mkdir(`${HOME}/.cache/quarto-os`);
      await this._writeFile(marker, new Date().toISOString() + '\n');
    } else {
      console.warn(`[quarto-os vm] setup script failed (exit ${r.code})`);
      this._setStatus(`Setup script failed (exit ${r.code})`);
    }
  }

  // --- console transport --------------------------------------------------

  // Queues one agent line. Lines go out in order; they are sent synchronously
  // unless a big transfer is in progress.
  _line(s) {
    this._q.push(s);
    this._pump();
  }

  _pump() {
    if (!this._up || this._checkpointing || !this._credit || !this._q.length) return;
    this._credit = false;
    this._sendText(this._q.shift() + '\n');
  }

  _activate(session) { this._active = session; }

  _writeSession(session, bytes) {
    for (let offset = 0; offset < bytes.length; offset += LINE_RAW) {
      const end = Math.min(offset + LINE_RAW, bytes.length);
      this._line(`\x02I ${session.id} ${b64encode(bytes, offset, end)}`);
    }
  }

  _onConsole(buf, vt) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (vt !== 1) { // a session's terminal
      const s = this._vts.get(vt);
      if (s && u8.length) { s._push(u8); this._activity(); }
      return;
    }
    // tty1: agent frames. Bytes outside STX..LF frames are logged, never parsed.
    const n = u8.length;
    let i = 0;
    while (i < n) {
      if (!this._inFrame) {
        const s = u8.indexOf(2, i);
        if (s < 0) { this._strayBytes(u8, i, n); return; }
        if (s > i) this._strayBytes(u8, i, s);
        this._inFrame = true;
        this._fl = 0;
        i = s + 1;
      }
      const e = u8.indexOf(10, i);
      const lim = e < 0 ? n : e;
      const s2 = u8.indexOf(2, i);
      if (s2 >= 0 && s2 < lim) { this._fl = 0; i = s2 + 1; continue; } // cut frame: resync
      if (e < 0) { this._partial(u8, i, n); return; }
      this._inFrame = false;
      if (this._fl) {
        this._partial(u8, i, e);
        const len = this._fl;
        this._fl = 0;
        this._frame(this._fb, 0, len);
      } else {
        this._frame(u8, i, e);
      }
      i = e + 1;
    }
  }

  _partial(u8, s, e) {
    const need = this._fl + (e - s);
    if (need > this._fb.length) {
      const nb = new Uint8Array(Math.max(need, this._fb.length * 2));
      nb.set(this._fb.subarray(0, this._fl));
      this._fb = nb;
    }
    this._fb.set(u8.subarray(s, e), this._fl);
    this._fl = need;
  }

  _strayBytes(u8, s, e) {
    this._stray += dec.decode(u8.subarray(s, e));
    let nl;
    while ((nl = this._stray.indexOf('\n')) >= 0) {
      const line = this._stray.slice(0, nl).replace(/\r$/, '');
      this._stray = this._stray.slice(nl + 1);
      if (this.isReady && line.trim()) console.log('[quarto-os vm]', line);
    }
    if (this._stray.length > 4096) this._stray = '';
  }

  // One frame: b[s] is the type letter, then " id [nums] [b64]".
  _frame(b, s, e) {
    while (e > s && b[e - 1] === 13) e--;
    const t = b[s];
    let p = s + 2;
    const num = () => {
      let v = 0, neg = false;
      if (b[p] === 45) { neg = true; p++; }
      while (p < e && b[p] !== 32) v = v * 10 + (b[p++] - 48);
      p++;
      return neg ? -v : v;
    };
    try {
      const id = num();
      switch (t) {
        case 97: // a: the agent consumed one input frame
          this._credit = true; this._pump();
          break;
        case 111: { // o: PTY output
          const session = this._sessions.get(id);
          if (session) { session._push(b64decode(b, p, e)); this._activity(); }
          break;
        }
        case 100: { // d: data chunk of a request
          const q = this._pending.get(id);
          if (q) {
            const chunk = b64decode(b, p, e);
            q.chunks.push(chunk);
            q.size += chunk.length;
            if (q.onData) safe(q.onData, chunk);
          }
          break;
        }
        case 114: { // r: request done
          const err = num(), val = num();
          const q = this._pending.get(id);
          if (!q) break;
          this._pending.delete(id);
          const payload = p < e ? b64decode(b, p, e) : null;
          if (err) {
            const msg = payload ? dec.decode(payload) : `error ${err}`;
            const ex = new Error(`${q.what}: ${msg}`);
            ex.code = ERRNO[err] || `E${err}`;
            ex.errno = err;
            q.reject(ex);
          } else {
            q.resolve({ num: val, chunks: q.chunks, size: q.size, payload });
          }
          break;
        }
        case 120: { // x: session exit
          const code = num();
          const sess = this._sessions.get(id);
          if (sess) {
            this._sessions.delete(id);
            if (this._vts.get(sess.vt) === sess) this._vts.delete(sess.vt);
            if (this._active === sess) this._active = null;
            sess._end(code);
          }
          this._activity();
          break;
        }
        case 104: // h: hello
          if (num() !== 3) {
            const error = new Error('Incompatible VM agent protocol; rebuild the agent');
            for (const waiter of this._upWaiters.splice(0)) waiter.reject(error);
            break;
          }
          this._onHello();
          break;
      }
    } catch (ex) {
      console.error('[quarto-os vm] bad frame', ex);
    }
  }

  // Sends a request and resolves with {num, chunks, size, payload}.
  _req(type, nums, body, { what = type, onData, id = this._nextId++ } = {}) {
    if (this._failure) return Promise.reject(this._failure);
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject, chunks: [], size: 0, onData, what });
      const head = `\x02${type} ${id}${nums.length ? ' ' + nums.join(' ') : ''}`;
      if (!body || !body.length) return this._line(head);
      for (let o = 0; o < body.length; o += LINE_RAW) {
        const end = Math.min(o + LINE_RAW, body.length);
        const piece = b64encode(body, o, end);
        this._line(end === body.length ? `${head} ${piece}` : `\x02+ ${id} ${piece}`);
      }
    });
  }

  _path(p) {
    p = p == null || p === '' ? '~' : String(p);
    if (p === '~') return HOME;
    if (p.startsWith('~/')) return HOME + p.slice(1);
    return p;
  }

  // --- internal operations (usable before `ready`, e.g. by setup) ----------

  async _stat(path) {
    const p = this._path(path);
    try {
      const r = await this._req('T', [], fields([p]), { what: `stat ${p}` });
      const e = parseRecord(dec.decode(r.payload).replace(/\0$/, ''));
      delete e.name;
      return e;
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
      throw e;
    }
  }

  async _readFile(path) {
    const p = this._path(path);
    const r = await this._req('R', [], fields([p]), { what: `read ${p}` });
    return r.size ? concat(r.chunks, r.size) : new Uint8Array(0);
  }

  async _readText(path) { return dec.decode(await this._readFile(path)); }

  async _writeFile(path, data, append = false) {
    const p = this._path(path);
    const u8 = toBytes(data);
    if (!append && u8.length > this._bulkWrite && this._dataDev) {
      // Bypass serial encoding for bulk data, then remove the temporary 9p file.
      const name = `/xfer-${++this._bulkSeq}-${Date.now().toString(36)}`;
      await this._dataDev.writeFile(name, u8);
      try {
        await this._req('F', [], fields(['/data' + name, p]), { what: `write ${p}` });
      } finally {
        await this._req('D', [], fields(['/data' + name]), { what: 'remove transfer file' });
      }
    } else {
      await this._req('W', [append ? 1 : 0], fields([p, u8]), { what: `write ${p}` });
    }
    this._activity();
  }

  async _mkdir(path) {
    const p = this._path(path);
    await this._req('M', [], fields([p]), { what: `mkdir ${p}` });
    this._activity();
  }

  async _exec(cmd, { cwd, env, onOutput, signal } = {}) {
    const dir = this._path(cwd);
    const id = this._nextId++;
    const td = onOutput ? new TextDecoder() : null;
    const onData = td ? (u8) => onOutput(td.decode(u8, { stream: true })) : undefined;
    const abort = () => this._line(`\x02K ${id} 9`);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const r = await this._req('X', [], fields([dir, String(cmd), ...envFields(env)]),
        { what: `exec in ${dir}`, onData, id });
      return { code: r.num, output: dec.decode(concat(r.chunks, r.size)) };
    } finally {
      signal?.removeEventListener('abort', abort);
      this._activity();
    }
  }

  // --- public API ---------------------------------------------------------

  /**
   * Opens a terminal session running `bash -l` (or `bash -lc cmd`; cmd may be
   * an argv array). opts: {cols, rows, cwd, cmd, env}. A missing cwd falls
   * back to ~. At most vm.maxSessions (6) sessions can be open at once.
   */
  async openSession({ cols = 80, rows = 24, cwd, cmd, env } = {}) {
    await this.ready;
    let vt = VT_FIRST;
    while (vt <= VT_LAST && this._vts.has(vt)) vt++;
    if (vt > VT_LAST) {
      throw new Error(`Too many terminals: at most ${this.maxSessions} can be open at once. Close one first.`);
    }
    if (this._firstSession) { this._firstSession = false; this._setStatus('Starting session…'); }
    if (Array.isArray(cmd)) cmd = cmd.map(shellQuote).join(' ');
    const id = this._nextId++;
    const s = new Session(this, id, vt, Math.max(1, cols | 0) || 80, Math.max(1, rows | 0) || 24);
    this._vts.set(vt, s); // before the request: catch output that races the reply
    this._sessions.set(id, s);
    this._activate(s);    // the shell starts with this session's size
    const dir = this._path(cwd);
    // SHLVL=1 → bash runs at level 2, so Debian's ~/.bash_logout does not
    // `clear_console` (which wipes a VT) when the session ends.
    env = { SHLVL: '1', ...env };
    try {
      const r = await this._req('S', [vt, s.cols, s.rows], fields([dir, cmd || '', ...envFields(env)]),
        { what: 'open session', id });
      s.pid = r.num;
      s.resize(s.cols, s.rows);
    } catch (e) {
      this._sessions.delete(id);
      this._vts.delete(vt);
      if (this._active === s) this._active = null;
      throw e;
    }
    return s;
  }

  /** Lists a directory (no . and ..), sorted by name. */
  async ls(path) {
    await this.ready;
    const p = this._path(path);
    const r = await this._req('L', [], fields([p]), { what: `ls ${p}` });
    const text = dec.decode(concat(r.chunks, r.size));
    const out = [];
    for (const rec of text.split('\0')) if (rec) out.push(parseRecord(rec));
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** {type, size, mtime, mode} following symlinks, or null if it does not exist. */
  async stat(path) { await this.ready; return this._stat(path); }

  async readFile(path) { await this.ready; return this._readFile(path); }

  async readText(path) { await this.ready; return this._readText(path); }

  /** Writes (creates/truncates) a file. data: string | Uint8Array | ArrayBuffer. */
  async writeFile(path, data) { await this.ready; return this._writeFile(path, data); }

  /** Runs `sh -c cmd` as user; resolves {code, output} (stdout+stderr merged).
   *  Extra opts: env, onOutput(text) for streaming, signal (AbortSignal → SIGKILL). */
  async exec(cmd, opts = {}) { await this.ready; return this._exec(cmd, opts); }

  /** mkdir -p */
  async mkdir(path) { await this.ready; return this._mkdir(path); }

  /** rm -r (a missing path is not an error; refuses "/"). */
  async remove(path) {
    await this.ready;
    const p = this._path(path);
    await this._req('D', [], fields([p]), { what: `remove ${p}` });
    this._activity();
  }

  async rename(from, to) {
    await this.ready;
    const a = this._path(from), b = this._path(to);
    await this._req('N', [], fields([a, b]), { what: `rename ${a} → ${b}` });
    this._activity();
  }

  /** Round trip to the agent in ms (diagnostics). */
  async ping() {
    await this.ready;
    const t0 = performance.now();
    await this._req('Q', [], null, { what: 'ping' });
    return performance.now() - t0;
  }

  /**
   * Calls cb(entries, error) with the listing of dir now and whenever it
   * changes. Polls: quickly after 'activity', every 3 s otherwise, never while
   * the page is hidden. Returns an unsubscribe function.
   */
  watch(dir, cb) {
    const path = this._path(dir);
    let w = this._watches.get(path);
    if (!w) {
      w = { path, cbs: new Set(), entries: null, sig: null, busy: false, again: false };
      this._watches.set(path, w);
    }
    w.cbs.add(cb);
    if (w.entries) queueMicrotask(() => w.cbs.has(cb) && safe(cb, w.entries, w.error));
    else this._pollWatch(w);
    if (!this._watchTimer) {
      this._watchTimer = setInterval(() => this._pollWatches(), WATCH_POLL_MS);
      this._onVisible = () => this._pollWatches();
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this._onVisible);
    }
    return () => {
      w.cbs.delete(cb);
      if (!w.cbs.size && this._watches.get(path) === w) this._watches.delete(path);
      if (!this._watches.size && this._watchTimer) {
        clearInterval(this._watchTimer);
        this._watchTimer = 0;
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this._onVisible);
      }
    };
  }

  _pollWatches() {
    if (hidden()) return;
    for (const w of this._watches.values()) this._pollWatch(w);
  }

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
          w.sig = sig; w.entries = entries; w.error = error;
          for (const cb of w.cbs) safe(cb, entries, error);
        }
      } while (w.again && w.cbs.size);
    } finally {
      w.busy = false;
    }
  }

  /** Deletes this cache and reloads from the pristine guest image. */
  async reset() {
    this._resetting = true;
    clearTimeout(this._saveTimer);
    globalThis.removeEventListener('pagehide', this._onPageHide);
    if (this._saving) { try { await this._saving; } catch { /* reset also recovers a failed checkpoint */ } }
    const db = this._db || await openStore(this.config.cacheId);
    await storeRequest(db, 'readwrite', store => store.clear());
    location.reload();
  }
}

let runtimePromise;
function loadRuntime(url) {
  if (!runtimePromise) runtimePromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.onload = () => globalThis.V86 ? resolve() : reject(new Error('v86 runtime did not load'));
    script.onerror = () => reject(new Error(`Could not load v86 from ${url}`));
    document.head.append(script);
  }).catch(error => { runtimePromise = null; throw error; });
  return runtimePromise;
}

function openStore(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name + ":v86", 1);
    request.onupgradeneeded = () => request.result.createObjectStore('snapshots');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('VM cache is open in another tab; close it and retry'));
  });
}

function storeRequest(db, mode, operation) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('snapshots', mode);
    const request = operation(transaction.objectStore('snapshots'));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error || request.error || new Error('VM cache transaction aborted'));
    transaction.onerror = () => {}; // onabort preserves the transaction's final outcome
  });
}

/** Creates the shared machine; await vm.ready before using it. */
export async function createVM(config, {baseUrl} = {}) {
  return new VM(config, baseUrl);
}
