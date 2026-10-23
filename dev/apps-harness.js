// Minimal stand-in for window.QuartoOS (the core) so the apps can be developed
// and tested in isolation. NOT shipped. See dev/SPEC.md "Core JS API".
//
// URL params:  ?vm=real   use ../_extensions/quarto-os/vm/vm.js instead of the mock
//              ?boot=ms   mock boot duration (default 1800, 0 = instant)
//              ?fail=1    mock VM boot failure
//              ?theme=dark

const params = new URLSearchParams(location.search);
const baseUrl = new URL('../_extensions/quarto-os/', location.href).href;
const APPS = {
  terminal: { title: 'Terminal', size: [620, 380], vm: true },
  explorer: { title: 'Files', size: [720, 440], vm: true },
  vscode: { title: 'VS Code', size: [900, 560], vm: true },
};

class Win {
  constructor(app, opts, container) {
    this.id = opts.id || 'w' + (++Win.n);
    this.app = app;
    this.opts = opts;
    this._l = {};
    const [w, h] = APPS[app]?.size || [520, 340];
    const el = this.el = document.createElement('div');
    el.className = 'qos-window' + ((opts.theme || QuartoOS.config.theme) === 'dark' ? ' qos-dark' : '');
    el.id = this.id;
    const cw = container.clientWidth || 1200, ch = container.clientHeight || 800;
    const W = parseInt(opts.width) || w, H = parseInt(opts.height) || h;
    Object.assign(el.style, {
      width: W + 'px', height: H + 'px',
      left: (opts.x != null ? +opts.x : Math.max(0, 30 + (Win.n * 37) % Math.max(1, cw - W - 40))) + 'px',
      top: (opts.y != null ? +opts.y : 20 + (Win.n * 29) % Math.max(1, ch - H - 30)) + 'px',
    });
    el.innerHTML = `<div class="qos-titlebar"><div class="qos-lights"><button class="l-close" title="Close"></button><button class="l-min" title="Minimize"></button><button class="l-max" title="Zoom"></button></div><div class="qos-title"></div></div><div class="qos-body"></div><div class="qos-placeholder">Loading ${APPS[app]?.title || app}…</div>`;
    this.body = el.querySelector('.qos-body');
    this._title = el.querySelector('.qos-title');
    this.setTitle(opts.title || APPS[app]?.title || app);
    el.querySelector('.l-close').onclick = e => { e.stopPropagation(); this.close(); };
    el.querySelector('.l-min').onclick = e => { e.stopPropagation(); this.minimize(); };
    el.querySelector('.l-max').onclick = e => { e.stopPropagation(); this.maximize(); };
    el.addEventListener('pointerdown', () => this.focus(), true);
    // drag
    const tb = el.querySelector('.qos-titlebar');
    tb.addEventListener('pointerdown', e => {
      if (e.target.closest('button')) return;
      const sx = e.clientX, sy = e.clientY, ox = el.offsetLeft, oy = el.offsetTop;
      const mv = ev => { el.style.left = ox + ev.clientX - sx + 'px'; el.style.top = Math.max(0, oy + ev.clientY - sy) + 'px'; };
      const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); };
      addEventListener('pointermove', mv); addEventListener('pointerup', up);
    });
    container.appendChild(el);
    new ResizeObserver(() => this._emit('resize')).observe(this.body);
  }
  on(ev, cb) { (this._l[ev] ||= new Set()).add(cb); return () => this._l[ev].delete(cb); }
  _emit(ev, ...a) { for (const cb of this._l[ev] || []) { try { cb(...a); } catch (e) { console.error(e); } } }
  setTitle(t) { this._title.textContent = t; }
  focus() {
    if (QuartoOS._focused === this) return;
    QuartoOS._focused?._emit('blur'); QuartoOS._focused?.el.classList.remove('focused');
    QuartoOS._focused = this; this.el.classList.add('focused');
    this.el.style.zIndex = ++Win.z;
    if (this.app === 'terminal') QuartoOS.lastTerminal = this;
    this._emit('focus');
  }
  close() {
    try { this.instance?.dispose?.(); } catch (e) { console.error(e); }
    this._emit('close'); this.el.remove();
    QuartoOS.windows.splice(QuartoOS.windows.indexOf(this), 1);
    if (QuartoOS.lastTerminal === this) QuartoOS.lastTerminal = null;
  }
  minimize() { this.el.style.display = 'none'; setTimeout(() => { this.el.style.display = ''; this._emit('resize'); }, 800); }
  maximize() { this.el.classList.toggle('max'); this._emit('resize'); }
  isVisible() { return !!this.el.offsetParent; }
}
Win.n = 0; Win.z = 10;

let vmP = null;
const loaded = new Map();
const QuartoOS = window.QuartoOS = {
  config: { theme: params.get('theme') || 'light', vm: { bootMs: params.has('boot') ? +params.get('boot') : 1800, fail: params.has('fail'), noIdent: params.has('noident') }, cdn: {} },
  baseUrl,
  apps: APPS,
  windows: [],
  lastTerminal: null,
  async open(app, opts = {}) {
    const origin = opts.origin; delete opts.origin;
    const container = (opts.target && document.getElementById(opts.target)) || (origin && origin.parentElement) || document.getElementById('desk') || document.body;
    const win = new Win(app, opts, container);
    QuartoOS.windows.push(win);
    win.focus();
    const mod = await import(`${baseUrl}apps/${app}.js`);
    win.instance = await mod.mount(win, { ...opts }, QuartoOS);
    win.el.querySelector('.qos-placeholder')?.remove();
    return win;
  },
  vm() {
    if (!vmP) {
      vmP = params.get('vm') === 'real'
        ? import(baseUrl + 'vm/vm.js').then(m => m.createVM(QuartoOS.config.vm, { baseUrl }))
        : import('./apps-mock-vm.js').then(m => m.createVM(QuartoOS.config.vm, { baseUrl }));
    }
    return vmP;
  },
  async run(text, target) {
    let w = target ? QuartoOS.windows.find(x => x.id === target) : QuartoOS.lastTerminal;
    if (!w) w = await QuartoOS.open('terminal', {});
    w.instance?.run?.(text);
    w.focus();
  },
  loadScript(url) {
    if (!loaded.has(url)) loaded.set(url, new Promise((res, rej) => {
      const d = window.define; window.define = undefined;
      const s = document.createElement('script');
      s.src = url;
      s.onload = () => { window.define = d; res(); };
      s.onerror = () => { window.define = d; rej(new Error('Failed to load ' + url)); };
      document.head.appendChild(s);
    }));
    return loaded.get(url);
  },
  loadCSS(url) {
    if (!loaded.has(url)) loaded.set(url, new Promise(res => {
      const l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = url; l.onload = l.onerror = () => res();
      document.head.appendChild(l);
    }));
    return loaded.get(url);
  },
};
