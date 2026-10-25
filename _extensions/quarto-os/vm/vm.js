// Quarto OS — VM layer.
//
// One shared, headless CheerpX Linux per page. CheerpX gives the page one
// control console (tty1) plus six virtual terminals (tty2..tty7):
//   - tty1 runs `qos-agent`, a tiny static i386 helper (agent/qos-agent.c)
//     that serves file access and exec and starts/supervises sessions, over a
//     line-oriented base64 protocol;
//   - every terminal session gets its own VT, whose bytes flow directly
//     between CheerpX and the Session (no agent hop, no encoding).
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
const VT_FIRST = 2, VT_LAST = 7; // session terminals (tty1 is the agent's console)
const LINE_RAW = 600;           // raw bytes per JS→agent line (800 base64 chars)
const SEND_SLICE_MS = 8;        // max time spent in send() before yielding
const BULK_WRITE = 64 * 1024;   // larger writes go through the DataDevice
const ACTIVITY_DEBOUNCE = 300;  // 'activity' fires this long after the last output…
const ACTIVITY_MAX_WAIT = 1000; // …but at least this often while output continues
const WATCH_POLL_MS = 3000;     // baseline poll for vm.watch()
const HOSTNAME = 'quarto-os';
const PROMPT_MARK = '# quarto-os: hostname';
// CheerpX has no hostname (sethostname is ENOSYS), so `\h` in Debian's PS1
// would print nothing ("user@:~$"). Appended to ~/.bashrc once.
const PROMPT_FIX = `\n${PROMPT_MARK} (the VM has none; show one in the prompt)\n` +
  `case "$PS1" in *'\\h'*) PS1="\${PS1//\\\\h/${HOSTNAME}}";; esac\n`;

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
// Self-healing disk socket
// ---------------------------------------------------------------------------
// CheerpX's CloudDevice reads the disk over one WebSocket and never reconnects
// when it drops (proxies close idle sockets: seen after ~35 s); from then on
// every uncached read, e.g. starting python3 after a pause, hangs forever.
// The protocol is simple: per connection the server first sends a text
// header, then answers each "start-end" text request with that many bytes.
// So for the disk URL we hand CheerpX a stand-in that reconnects on demand,
// swallows the repeated header and re-sends unanswered requests.

class DiskSocket extends EventTarget {
  constructor(Native, url) {
    super();
    this._Native = Native;
    this.url = url;
    this.binaryType = 'arraybuffer';
    this.onmessage = this.onerror = this.onopen = this.onclose = null;
    this._queue = [];       // unanswered requests: [request, bytes still expected]
    this._header = false;   // the first connection's header was delivered
    this._closed = false;   // closed by CheerpX
    this._failed = false;
    this._retry = 0;
    this._timer = 0;
    this._connect();
  }

  get readyState() { return this._closed ? 3 : this._header ? 1 : 0; }

  _connect() {
    const ws = this._ws = new this._Native(this.url);
    ws.binaryType = 'arraybuffer';
    this._live = false; // header received on this connection
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        this._live = true;
        this._retry = 0;
        if (this._header) { for (const q of this._queue) ws.send(q[0]); return; } // reconnected
        this._header = true;
      } else if (this._queue.length) {
        const q = this._queue[0];
        q[1] -= e.data.byteLength;
        if (q[1] <= 0 || e.data.byteLength <= 1) this._queue.shift(); // ≤1 byte: CheerpX control reply
      }
      this._emit(new MessageEvent('message', { data: e.data }));
    };
    ws.onerror = () => { if (!this._header) this._fail(); };
    ws.onclose = () => {
      if (this._closed || this._ws !== ws) return;
      if (!this._header) return this._fail();
      if (!this._live) this._retry++;
      this._live = false;
      if (this._queue.length) this._reconnect(); // else: lazily, on the next request
    };
    ws.onopen = () => { if (!this._header) this._emit(new Event('open')); };
  }

  _fail() { // the first connection failed: let CheerpX see it (vm.js then tries https)
    if (this._failed) return;
    this._failed = true;
    this._emit(new Event('error'));
  }

  _reconnect() {
    if (this._timer || this._closed) return;
    const delay = this._retry ? Math.min(8000, 250 * 2 ** this._retry) : 0;
    this._timer = setTimeout(() => { this._timer = 0; if (!this._closed) this._connect(); }, delay);
  }

  send(data) {
    const m = /^(\d+)-(\d+)$/.exec(String(data));
    this._queue.push([data, m ? +m[2] - +m[1] + 1 : 1]);
    const ws = this._ws;
    if (this._live && ws.readyState === 1) ws.send(data);
    else if (ws.readyState >= 2) this._reconnect();
    // else (re)connecting: queued requests go out when the header arrives
  }

  close() {
    this._closed = true;
    clearTimeout(this._timer);
    try { this._ws.close(); } catch { /* ignore */ }
  }

  _emit(ev) {
    const h = this['on' + ev.type];
    if (h) safe(() => h.call(this, ev));
    this.dispatchEvent(ev);
  }
}

function installDiskSocket(diskUrl) {
  const Native = globalThis.WebSocket;
  if (!Native || Native.__qosDisks) { Native?.__qosDisks?.add(diskUrl); return; }
  const disks = new Set([diskUrl]);
  function WebSocket(url, protocols) {
    if (disks.has(String(url))) return new DiskSocket(Native, String(url));
    return protocols === undefined ? new Native(url) : new Native(url, protocols);
  }
  WebSocket.prototype = Native.prototype; // instanceof keeps working
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) WebSocket[k] = Native[k];
  WebSocket.__qosDisks = disks;
  globalThis.WebSocket = WebSocket;
}

// ---------------------------------------------------------------------------
// Session: a shell on one of the VM's virtual terminals
// ---------------------------------------------------------------------------

class Session {
  constructor(vm, id, vt, cols, rows) {
    this.vm = vm;
    this.id = id;
    this.vt = vt;            // /dev/tty<vt> inside the VM
    this.pid = 0;
    this.cols = cols;
    this.rows = rows;
    this.exited = false;
    this.exitCode = null;
    // CheerpX VTs do not translate output "\n" into "\r\n" (no ONLCR); the
    // session does it so any terminal emulator works unchanged.
    this.convertEol = true;
    this._data = new Set();
    this._exit = new Set();
    this._early = [];        // output that arrived before the first onData()
    this._prevCR = false;
    this._hold = null;       // input queued while a Ctrl-C is being resolved
    this._rz = 0;
  }

  /** Sends keyboard input (string or bytes). Also makes this session's size the VM's current one. */
  write(data) {
    if (this.exited) return;
    const u8 = toBytes(data);
    if (!u8.length) return;
    if (this._hold) { this._hold.push(u8); return; }
    this.vm._activate(this);
    const ctrlC = u8.indexOf(3);
    if (ctrlC < 0) { this._send(u8, 0, u8.length); return; }
    // ^C: let the agent decide between SIGINT (non-canonical + ISIG, which
    // CheerpX ignores) and passing the byte on; keep later input in order.
    this._send(u8, 0, ctrlC);
    this._hold = [u8.subarray(ctrlC + 1)];
    this.vm._req('Y', [], null, { id: this.id, what: 'interrupt' }).then(
      (r) => r.num === 1, () => false,
    ).then((handled) => {
      if (!handled && !this.exited) this.vm._send(3, this.vt);
      const queued = this._hold;
      this._hold = null;
      for (const c of queued) this.write(c);
    });
  }

  _send(u8, s, e) {
    const send = this.vm._send, vt = this.vt;
    for (let i = s; i < e; i++) send(u8[i], vt);
  }

  /** Sets the terminal size (coalesced, ≤ 1 update per 30 ms). */
  resize(cols, rows) {
    this.cols = Math.max(1, cols | 0);
    this.rows = Math.max(1, rows | 0);
    if (this._rz) return;
    this._applySize();
    this._rz = setTimeout(() => { this._rz = 0; this._applySize(); }, 30);
  }

  _applySize() {
    // CheerpX VTs share one size; it follows the session in use (see activate).
    if (!this.exited && (this.vm._active === this || !this.vm._active)) this.vm._activate(this);
  }

  /**
   * Makes this session's cols/rows the VM's terminal size (CheerpX VTs share
   * a single size) and lets its foreground program know (SIGWINCH). Called
   * automatically on write(); terminals may also call it on focus.
   */
  activate() { if (!this.exited) this.vm._activate(this); }

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
    if (out === u8) out = u8.slice(); // never hand out CheerpX's buffer
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
    this.maxSessions = VT_LAST - VT_FIRST + 1;
    this._agentUrl = baseUrl
      ? String(baseUrl).replace(/\/?$/, '/') + 'vm/qos-agent'
      : new URL('qos-agent', import.meta.url).href;

    this._listeners = { status: new Set(), activity: new Set() };
    this._pending = new Map();   // request id → {resolve, reject, chunks, size, onData, what}
    this._sessions = new Map();  // session id → Session
    this._vts = new Map();       // vt number → Session
    this._active = null;         // session whose size the VTs currently have
    this._size = [0, 0];
    this._nextId = 1;
    this._q = [];                // outgoing agent lines (FIFO, keeps request order)
    this._qh = 0;
    this._pumping = false;
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
    this._consoleCb = (buf, vt) => this._onConsole(buf, vt);

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

  // Debounced 'activity': 300 ms after the last trigger, at least every
  // second while triggers keep coming. One timer, re-armed only when it fires
  // (this runs for every chunk of terminal output).
  _activity() {
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
          if (disk.startsWith('wss:')) installDiskSocket(disk);
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
    // A session opened before boot finished may already have picked a size.
    const [cols, rows] = this._active ? [this._active.cols, this._active.rows] : [80, 24];
    this._size = [cols, rows];
    this._send = this._cx.setCustomConsole(this._consoleCb, cols, rows);
    await this._dataDev.writeFile('/qos-agent', new Uint8Array(await agent));

    const up = this._waitUp();
    this._agentLoop();
    await up;
    // Warm the disk cache for what a terminal needs (bash, its libraries,
    // profile/.bashrc helpers: ~5 s of cold disk reads, 0.35 s warm) while
    // the steps below run and before anyone opens a terminal.
    this._exec('bash -lic exit < /dev/null', { env: { SHLVL: '1', HISTFILE: '/dev/null' } }).catch(() => {});
    await this._ensureDefaults();
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
    const bashrc = await this._readText(`${HOME}/.bashrc`).catch(() => null);
    if (bashrc !== null && !bashrc.includes(PROMPT_MARK)) await this._writeFile(`${HOME}/.bashrc`, PROMPT_FIX, true);
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

  // CheerpX VTs share one size: give them the size of the session in use and
  // tell its foreground program (CheerpX raises no SIGWINCH itself).
  _activate(s) {
    this._active = s;
    if (!this._cx || (this._size[0] === s.cols && this._size[1] === s.rows)) return;
    this._size = [s.cols, s.rows];
    this._send = this._cx.setCustomConsole(this._consoleCb, s.cols, s.rows);
    if (s.pid && !s.exited) this._line(`\x02Z ${s.id}`);
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
      // Bulk path: hand the bytes to the VM through the DataDevice (fast) and
      // let the agent copy them. DataDevice files cannot be deleted or
      // overwritten, hence a fresh name per transfer.
      const name = `/xfer-${++this._bulkSeq}-${Date.now().toString(36)}`;
      await this._dataDev.writeFile(name, u8);
      await this._req('F', [], fields(['/data' + name, p]), { what: `write ${p}` });
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
      const r = await this._req('S', [vt], fields([dir, cmd || '', ...envFields(env)]),
        { what: 'open session', id });
      s.pid = r.num;
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
