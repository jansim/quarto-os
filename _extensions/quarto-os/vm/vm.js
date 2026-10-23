// Quarto OS — VM layer.
//
// One shared, headless CheerpX Linux per page. CheerpX exposes a single
// console, so everything (any number of pty sessions, file access, exec) is
// multiplexed over it by `qos-agent`, a tiny static i386 helper that runs
// inside the VM (source and wire protocol: agent/qos-agent.c).
//
//   const vm = await createVM(QuartoOS.config.vm, { baseUrl: QuartoOS.baseUrl });
//   vm.on('status', msg => …);  await vm.ready;
//   const s = await vm.openSession({ cols: 80, rows: 24, cwd: '~' });
//   s.onData(bytes => term.write(bytes));  term.onData(str => s.write(str));
//
// Dependency free. All paths accept a leading `~` (= vm.home).

const CX_VERSION = '1.4.0';
const DEFAULT_DISK = 'wss://disks.webvm.io/debian_buster_large_permis_fixed_01-06-2026.ext2';
const HOME = '/home/user';
const AGENT_ENV = ['HOME=' + HOME, 'USER=user', 'PATH=/usr/local/bin:/usr/bin:/bin'];
const LINE_RAW = 600;           // raw bytes per JS→agent line (800 base64 chars)
const SEND_SLICE_MS = 8;        // max time spent in send() before yielding
const BULK_WRITE = 64 * 1024;   // larger writes go through the DataDevice
const ACTIVITY_DEBOUNCE = 300;  // 'activity' fires this long after the last output…
const ACTIVITY_MAX_WAIT = 1000; // …but at least this often while output continues
const WATCH_POLL_MS = 3000;     // baseline poll for vm.watch()

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

// ---------------------------------------------------------------------------
// Session: one pty in the VM
// ---------------------------------------------------------------------------

class Session {
  constructor(vm, id, cols, rows) {
    this.vm = vm;
    this.id = id;
    this.pid = 0;
    this.cols = cols;
    this.rows = rows;
    this.exited = false;
    this.exitCode = null;
    this._data = new Set();
    this._exit = new Set();
    this._early = [];     // output that arrived before the first onData()
    this._want = null;
    this._rz = 0;
  }

  /** Sends keyboard input (string or bytes) to the pty. */
  write(data) {
    if (this.exited) return;
    const u8 = toBytes(data);
    for (let o = 0; o < u8.length; o += LINE_RAW) {
      this.vm._line(`\x02I ${this.id} ${b64encode(u8, o, Math.min(o + LINE_RAW, u8.length))}`);
    }
  }

  /** Resizes the pty (coalesced: at most one resize per 30 ms reaches the VM). */
  resize(cols, rows) {
    this._want = [Math.max(1, cols | 0), Math.max(1, rows | 0)];
    if (this._rz) return;
    this._applySize();
    this._rz = setTimeout(() => { this._rz = 0; this._applySize(); }, 30);
  }

  _applySize() {
    const [c, r] = this._want;
    if (this.exited || (c === this.cols && r === this.rows)) return;
    this.cols = c; this.rows = r;
    this.vm._line(`\x02Z ${this.id} ${c} ${r}`);
  }

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

  /** cb(code) once the shell exits (code = exit status, 128+signal, -1 if the VM agent died). */
  onExit(cb) {
    if (this.exited) queueMicrotask(() => cb(this.exitCode));
    else this._exit.add(cb);
    return () => this._exit.delete(cb);
  }

  /** Sends a signal (number, default SIGTERM) to every process of the session. */
  kill(sig = 15) { if (!this.exited) this.vm._line(`\x02K ${this.id} ${sig | 0}`); }

  /** Hangs up the session; onExit fires when it is gone. */
  close() { if (!this.exited) this.vm._line(`\x02C ${this.id}`); }

  _push(chunk) {
    if (this._early) this._early.push(chunk);
    else for (const cb of this._data) safe(cb, chunk);
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
    const pick = (camel, kebab, dflt) => c[camel] ?? c[kebab] ?? dflt;
    const bool = (v) => v === true || v === 'true';
    this.config = {
      disk: pick('disk', 'disk', DEFAULT_DISK),
      diskType: pick('diskType', 'disk-type', 'cloud'),
      persist: bool(pick('persist', 'persist', false)),
      cacheId: String(pick('cacheId', 'cache-id', 'quarto-os')),
      setup: pick('setup', 'setup', ''),
      cheerpx: pick('cheerpx', 'cheerpx', CX_VERSION),
    };
    this.home = HOME;
    this.status = '';
    this.isReady = false;
    this._agentUrl = baseUrl
      ? String(baseUrl).replace(/\/?$/, '/') + 'vm/qos-agent'
      : new URL('qos-agent', import.meta.url).href;

    this._listeners = { status: new Set(), activity: new Set() };
    this._pending = new Map();   // request id → {resolve, reject, chunks, size, onData, what}
    this._sessions = new Map();  // session id → Session
    this._nextId = 1;
    this._q = [];                // outgoing lines (FIFO, keeps request order)
    this._qh = 0;
    this._pumping = false;
    this._up = false;            // agent said hello and is accepting lines
    this._upWaiters = [];
    this._fb = new Uint8Array(1 << 16); // partial frame across console chunks
    this._fl = 0;
    this._inFrame = false;
    this._stray = '';
    this._act = { timer: 0, first: 0 };
    this._watches = new Map();
    this._watchTimer = 0;
    this._bulkSeq = 0;
    this._bulkWrite = BULK_WRITE;
    this._firstSession = true;

    const mc = new MessageChannel();
    mc.port1.onmessage = () => { this._pumping = false; this._pump(); };
    this._wake = () => mc.port2.postMessage(0);

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

  // Debounced 'activity': 300 ms after the last trigger, at least every second.
  _activity() {
    if (!this._listeners.activity.size && !this._watches.size) return;
    const a = this._act, now = performance.now();
    if (!a.first) a.first = now;
    clearTimeout(a.timer);
    a.timer = setTimeout(() => {
      a.first = 0;
      for (const cb of this._listeners.activity) safe(cb);
      this._pollWatches();
    }, Math.max(0, Math.min(ACTIVITY_DEBOUNCE, a.first + ACTIVITY_MAX_WAIT - now)));
  }

  // --- boot ---------------------------------------------------------------

  async _loadCheerpX() {
    const v = String(this.config.cheerpx);
    const url = /^[\w.-]+$/.test(v) ? `https://cxrtnc.leaningtech.com/${v}/cx.esm.js` : v;
    try {
      return await import(/* webpackIgnore: true */ url);
    } catch (e) {
      throw new Error(`Could not load CheerpX from ${url} (${e.message})`);
    }
  }

  async _openDisk(CX) {
    const { disk, diskType } = this.config;
    const abs = (u) => new URL(u, document.baseURI).href;
    try {
      switch (diskType) {
        case 'cloud':
          try {
            return await CX.CloudDevice.create(disk);
          } catch (e) {
            if (!disk.startsWith('wss:')) throw e;
            return await CX.CloudDevice.create('https:' + disk.slice(4)); // like WebVM
          }
        case 'bytes': return await CX.HttpBytesDevice.create(abs(disk));
        case 'github': return await CX.GitHubDevice.create(abs(disk));
        default: throw new Error(`unknown disk type "${diskType}" (expected cloud, github or bytes)`);
      }
    } catch (e) {
      throw new Error(`Could not open the VM disk ${disk}: ${e.message || e}`);
    }
  }

  async _boot() {
    this._setStatus('Loading CheerpX…');
    const agent = fetch(this._agentUrl).then((r) => {
      if (!r.ok) throw new Error(`Could not load the VM agent ${this._agentUrl} (HTTP ${r.status})`);
      return r.arrayBuffer();
    });
    agent.catch(() => {});
    const CX = this._CX = await this._loadCheerpX();

    this._setStatus('Connecting to disk…');
    const block = await this._openDisk(CX);
    this._idb = await CX.IDBDevice.create(this.config.cacheId);
    if (!this.config.persist) await this._idb.reset(); // fresh VM on every page load
    const overlay = await CX.OverlayDevice.create(block, this._idb);
    this._dataDev = await CX.DataDevice.create();

    this._setStatus('Booting Linux…');
    this._cx = await CX.Linux.create({
      mounts: [
        { type: 'ext2', dev: overlay, path: '/' },
        { type: 'dir', dev: this._dataDev, path: '/data' },
        { type: 'devs', path: '/dev' },
        { type: 'devpts', path: '/dev/pts' },
        { type: 'proc', path: '/proc' },
        { type: 'sys', path: '/sys' },
      ],
    });
    this._send = this._cx.setCustomConsole((buf, vt) => this._onConsole(buf, vt), 80, 24);
    await this._dataDev.writeFile('/qos-agent', new Uint8Array(await agent));

    const up = this._waitUp();
    this._agentLoop();
    await up;
    await this._runSetup();
  }

  _waitUp() {
    if (this._up) return Promise.resolve();
    return new Promise((resolve, reject) => this._upWaiters.push({ resolve, reject }));
  }

  // Runs the agent forever. It is executed straight from the DataDevice; if
  // that ever fails to start, fall back to copying it into /tmp first.
  async _agentLoop() {
    const opts = { env: AGENT_ENV, cwd: HOME, uid: 1000, gid: 1000 };
    const copy = 'cat /data/qos-agent > /tmp/qos-agent && chmod 755 /tmp/qos-agent && exec /tmp/qos-agent';
    let viaTmp = false, failures = 0;
    for (;;) {
      this._hello = false;
      let err = null;
      try {
        if (viaTmp) await this._cx.run('/bin/sh', ['-c', copy], opts);
        else await this._cx.run('/data/qos-agent', [], opts);
      } catch (e) { err = e; }
      const started = this._hello;
      this._agentDown(new Error('The Linux VM agent stopped' + (err ? `: ${err.message || err}` : '')));
      if (started) { failures = 0; console.warn('[quarto-os vm] agent exited, restarting'); }
      else if (!viaTmp) viaTmp = true;
      else if (++failures >= 3) {
        const e = new Error('The Linux VM agent could not be started' + (err ? `: ${err.message || err}` : ''));
        for (const w of this._upWaiters.splice(0)) w.reject(e);
        return;
      }
      await sleep(300);
    }
  }

  _onHello() {
    this._hello = true;
    this._up = true;
    for (const w of this._upWaiters.splice(0)) w.resolve();
    this._pump();
  }

  _agentDown(err) {
    this._up = false;
    this._q.length = 0; this._qh = 0;
    this._fl = 0; this._inFrame = false;
    for (const p of this._pending.values()) p.reject(err);
    this._pending.clear();
    for (const s of this._sessions.values()) s._end(-1);
    this._sessions.clear();
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

  // Queues one protocol line. Lines go out in order; keystrokes are sent
  // synchronously unless a big transfer is in progress.
  _line(s) {
    this._q.push(s);
    if (!this._pumping) this._pump();
  }

  _pump() {
    if (!this._up || !this._send) return;
    const q = this._q, send = this._send, t0 = performance.now();
    while (this._qh < q.length) {
      const s = q[this._qh];
      q[this._qh++] = undefined;
      for (let i = 0; i < s.length; i++) send(s.charCodeAt(i));
      send(10);
      if (this._qh < q.length && performance.now() - t0 > SEND_SLICE_MS) {
        this._pumping = true;
        this._wake(); // continue in a fresh task so the page stays responsive
        return;
      }
    }
    q.length = 0;
    this._qh = 0;
  }

  // Console output → frames. Bytes outside STX..LF frames are logged, never parsed.
  _onConsole(buf, vt) {
    if (vt !== 1) return;
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
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
      if (line.trim()) console.log('[quarto-os vm]', line);
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
        case 111: { // o: session output
          const sess = this._sessions.get(id);
          if (sess) sess._push(b64decode(b, p, e));
          this._activity();
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
          this._sessions.delete(id);
          if (sess) sess._end(code);
          this._activity();
          break;
        }
        case 104: // h: hello
          this._onHello();
          break;
      }
    } catch (ex) {
      console.error('[quarto-os vm] bad frame', ex);
    }
  }

  // Sends a request and resolves with {num, chunks, size, payload}.
  _req(type, nums, body, { what = type, onData, id = this._nextId++ } = {}) {
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

  async _writeFile(path, data) {
    const p = this._path(path);
    const u8 = toBytes(data);
    if (u8.length > this._bulkWrite && this._dataDev) {
      // Bulk path: hand the bytes to the VM through the DataDevice (fast) and
      // let the agent copy them. DataDevice files cannot be deleted or
      // overwritten, hence a fresh name per transfer.
      const name = `/xfer-${++this._bulkSeq}-${Date.now().toString(36)}`;
      await this._dataDev.writeFile(name, u8);
      await this._req('F', [], fields(['/data' + name, p]), { what: `write ${p}` });
    } else {
      await this._req('W', [0], fields([p, u8]), { what: `write ${p}` });
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
   * Opens a pty running `bash -l` (or `bash -lc cmd`; cmd may be an argv array).
   * opts: {cols, rows, cwd, cmd, env}. A missing cwd falls back to ~.
   */
  async openSession({ cols = 80, rows = 24, cwd, cmd, env } = {}) {
    await this.ready;
    if (this._firstSession) { this._firstSession = false; this._setStatus('Starting session…'); }
    if (Array.isArray(cmd)) cmd = cmd.map(shellQuote).join(' ');
    const id = this._nextId++;
    const s = new Session(this, id, cols | 0 || 80, rows | 0 || 24);
    this._sessions.set(id, s); // before the request: catch output that races the reply
    const dir = this._path(cwd);
    try {
      const r = await this._req('S', [s.cols, s.rows], fields([dir, cmd || '', ...envFields(env)]),
        { what: 'open session', id });
      s.pid = r.num;
    } catch (e) {
      this._sessions.delete(id);
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

  async readFile(path) {
    await this.ready;
    const p = this._path(path);
    const r = await this._req('R', [], fields([p]), { what: `read ${p}` });
    return r.size ? concat(r.chunks, r.size) : new Uint8Array(0);
  }

  async readText(path) { return dec.decode(await this.readFile(path)); }

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

  /** Wipes the IndexedDB overlay (all VM changes) and reloads the page. */
  async reset() {
    try {
      const CX = this._CX || (this._CX = await this._loadCheerpX());
      const idb = this._idb || await CX.IDBDevice.create(this.config.cacheId);
      await idb.reset();
    } finally {
      location.reload();
    }
  }
}

/**
 * Creates the page's VM. Resolves immediately (boot runs in the background;
 * await vm.ready). Rejects if the page is not cross-origin isolated.
 */
export async function createVM(config, { baseUrl } = {}) {
  if (!globalThis.crossOriginIsolated) {
    throw new Error('The Linux VM needs a cross-origin isolated page (COOP: same-origin and ' +
      'COEP: require-corp or credentialless). Quarto OS registers coi-serviceworker.js for this; ' +
      'make sure `coi` is not disabled and reload the page, or serve the site with those headers.');
  }
  return new VM(config, baseUrl);
}
