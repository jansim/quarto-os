/*! Quarto OS core: macOS-style windows, desktops, launchers and a lazy app loader. MIT */
(function () {
  'use strict';
  if (window.QuartoOS) return;
  const W = window, D = document, NAV = navigator;
  const cur = D.currentScript;
  const baseUrl = cur && cur.src ? cur.src.replace(/[?#].*$/, '').replace(/[^/]*$/, '') : '';
  const reduced = () => W.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------------------------------------------------------------- helpers
  const $$ = (s, r) => Array.from((r || D).querySelectorAll(s));
  const h = (tag, cls, html) => { const e = D.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const px = v => v == null || v === '' ? '' : /^-?\d+(\.\d+)?$/.test(String(v).trim()) ? String(v).trim() + 'px' : String(v);
  const num = (v, d) => { const n = parseFloat(v); return isNaN(n) ? d : n; };
  const yes = v => v === true || v === 'true' || v === 'yes' || v === '1';
  const opt = el => { try { return JSON.parse(el.getAttribute('data-qos-opts') || '{}'); } catch (e) { return {}; } };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const svgUrl = svg => 'data:image/svg+xml,' + encodeURIComponent(svg);
  const icon = (app, cls) => { const i = h('img', cls || 'qos-icon'); i.alt = ''; i.draggable = false; i.src = svgUrl((apps[app] || apps.content).icon); return i; };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const anim = (el, kf, ms) => (!reduced() && el.animate) ? el.animate(kf, { duration: ms, easing: 'cubic-bezier(.2,.8,.2,1)' }).finished.catch(() => {}) : Promise.resolve();
  const Reveal = () => W.Reveal && W.Reveal.getScale ? W.Reveal : null;
  const slideOf = el => Reveal() && el && el.closest ? el.closest('.reveal .slides section') : null;

  // ---------------------------------------------------------------- icons
  const sq = (fill, extra) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs>${fill}</defs><rect x="4" y="4" width="56" height="56" rx="13" fill="url(#b)"/><rect x="4.5" y="4.5" width="55" height="55" rx="12.5" fill="none" stroke="#fff" stroke-opacity=".22"/>${extra}</svg>`;
  const lg = (id, a, b, x2) => `<linearGradient id="${id}" x1="0" y1="0" x2="${x2 || 0}" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>`;
  const ICONS = {
    terminal: sq(lg('b', '#5b5b63', '#1d1d21'), '<rect x="9" y="11" width="46" height="40" rx="5" fill="#111114"/><path d="M16 23l8 6.5-8 6.5" fill="none" stroke="#f2f2f2" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M28 39h12" stroke="#f2f2f2" stroke-width="3.6" stroke-linecap="round"/>'),
    vscode: sq(lg('b', '#47b4ff', '#0b63c9'), '<g fill="none" stroke="#fff" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 21L12 32l11 11M41 21l11 11-11 11"/><path d="M36 17l-8 30" stroke-opacity=".7"/></g>'),
    explorer: sq(lg('b', '#f6f9fe', '#d3e3f6') + lg('f', '#7cc4ff', '#2e8ef0'), '<path d="M12 21a3 3 0 0 1 3-3h10l4 4h20a3 3 0 0 1 3 3v19H12z" fill="#1f73d6"/><path d="M12 27a3 3 0 0 1 3-3h34a3 3 0 0 1 3 3v18a3 3 0 0 1-3 3H15a3 3 0 0 1-3-3z" fill="url(#f)"/><path d="M12.5 28.5h39" stroke="#fff" stroke-opacity=".45"/>'),
    browser: sq(lg('b', '#ffffff', '#e1e4ea') + lg('g', '#62d2ff', '#1769e0'), '<circle cx="32" cy="32" r="20" fill="url(#g)"/><g fill="none" stroke="#fff" stroke-opacity=".9" stroke-width="2"><ellipse cx="32" cy="32" rx="8.5" ry="20"/><path d="M12 32h40M15.5 21.5h33M15.5 42.5h33M32 12v40"/></g>'),
    content: sq(lg('b', '#ffd86b', '#f29b1d'), '<path d="M20 13h17l9 9v29a2 2 0 0 1-2 2H20a2 2 0 0 1-2-2V15a2 2 0 0 1 2-2z" fill="#fff"/><path d="M37 13v9h9" fill="#e9e9ee"/><path d="M23 30h17M23 36h17M23 42h11" stroke="#b9bcc4" stroke-width="2.4" stroke-linecap="round"/>')
  };
  const LIGHTS = '<div class="qos-lights">' +
    '<button type="button" class="qos-light qos-close" aria-label="Close" title="Close"><svg viewBox="0 0 12 12"><path d="M3.6 3.6l4.8 4.8M8.4 3.6l-4.8 4.8"/></svg></button>' +
    '<button type="button" class="qos-light qos-min" aria-label="Minimize" title="Minimize"><svg viewBox="0 0 12 12"><path d="M2.8 6h6.4"/></svg></button>' +
    '<button type="button" class="qos-light qos-max" aria-label="Zoom" title="Zoom"><svg viewBox="0 0 12 12"><path d="M3.2 4.4v4.4h4.4zM8.8 7.6V3.2H4.4z"/></svg></button></div>';

  // ---------------------------------------------------------------- app registry
  const apps = {
    terminal: { title: 'Terminal', icon: ICONS.terminal, module: 'apps/terminal.js', vm: true, size: [640, 380] },
    vscode: { title: 'Code', icon: ICONS.vscode, module: 'apps/vscode.js', vm: true, size: [900, 560] },
    explorer: { title: 'Files', icon: ICONS.explorer, module: 'apps/explorer.js', vm: true, size: [680, 420] },
    browser: { title: 'Browser', icon: ICONS.browser, vm: false, size: [820, 540], mount: mountBrowser },
    content: { title: 'Window', icon: ICONS.content, vm: false, size: [480, 320], mount: mountContent }
  };

  let config = {};
  const windows = [];
  let zTop = 20, uid = 0, seq = 0, overlay = null, focused = null;
  const alive = w => w && w.state !== 'closed' && windows.includes(w);
  const recent = (list) => list.filter(w => w.seq).sort((a, b) => b.seq - a.seq)[0] || null;
  // after a window goes away, activate the most recent remaining one in the same container
  function activateNext(win) {
    if (!win.floating) return;
    const next = recent(windows.filter(w => w !== win && w.floating && w.host.el === win.host.el && w.state !== 'minimized' && w.state !== 'closed'));
    if (next) next.focus(true);
  }
  const desktops = [];

  // ---------------------------------------------------------------- Win
  class Win {
    constructor(el, opts, host) {
      this.opts = opts = Object.assign({}, opts);
      this.app = opts.app || 'content';
      this.def = apps[this.app] || { title: this.app, icon: ICONS.content, size: [560, 360] };
      this.el = el;
      this.id = el.id || (el.id = 'qos-win-' + (++uid));
      this.l = {};
      this.instance = null;
      this.state = 'normal';
      this.mounted = false;
      this.theme = opts.theme || config.theme || 'light';
      el.qosWin = this;
      el.classList.add('qos-window', 'qos-ready', 'qos-app-' + this.app.replace(/[^\w-]/g, ''));
      if (this.theme === 'dark') el.classList.add('qos-dark');
      if (this.theme === 'auto') el.classList.add('qos-auto');

      let body = el.querySelector(':scope > .qos-body');
      if (!body) { body = h('div', 'qos-body'); while (el.firstChild) body.appendChild(el.firstChild); }
      body.classList.add('qos-body');
      const bar = h('div', 'qos-titlebar', LIGHTS + '<div class="qos-title"></div>');
      el.replaceChildren(bar, body);
      this.body = body; this.bar = bar; this.titleEl = bar.lastChild;
      if (this.app === 'content') classifyContent(this);
      this.setTitle(opts.title != null ? opts.title : (this.autoTitle || (this.app === 'content' ? '' : this.def.title)));
      el.setAttribute('role', 'group');

      this.ready = new Promise(r => { this._ready = r; });
      this.place(host);
      this.wire();
      windows.push(this);
      if (opts.state === 'minimized' && this.desk) this.minimize(true);
      else if (opts.state === 'maximized' && this.desk) this.maximize();
    }

    // -- placement: host = {type: 'desktop'|'slide'|'overlay'|'anchor'|'inline', el, desk}
    place(host) {
      const el = this.el, o = this.opts, sz = this.def.size;
      this.host = host;
      this.desk = host.desk || null;
      this.floating = host.type !== 'inline';
      el.classList.toggle('qos-floating', this.floating);
      el.classList.toggle('qos-inline', !this.floating);
      if (!this.floating) {
        el.style.width = px(o.width);
        el.style.height = px(o.height) || (this.app === 'content' ? '' : sz[1] + 'px');
        if (!o.width && this.app !== 'content') el.style.width = '100%';
        return;
      }
      if (el.parentNode !== host.el) host.el.appendChild(el);
      const box = this.box();
      let w = px(o.width) || Math.min(sz[0], Math.max(240, box.w - 24)) + 'px';
      let hh = px(o.height) || (this.app === 'content' && host.type === 'anchor' ? '' : Math.min(sz[1], Math.max(140, box.h - 60)) + 'px');
      el.style.width = w; el.style.height = hh;
      let x = o.x, y = o.y;
      if (x == null || y == null) {
        // cascade from the front-most window of this host (like macOS), else start near the top left / center
        const ww = el.offsetWidth || num(w, 400), wh = el.offsetHeight || num(hh, 300);
        const prev = windows.filter(v => v.host.el === host.el && v.state === 'normal' && v.floating).sort((a, b) => (+b.el.style.zIndex) - (+a.el.style.zIndex))[0];
        let cx, cy;
        if (host.type === 'anchor') cx = cy = 0;
        else if (prev) { cx = prev.el.offsetLeft + 26; cy = prev.el.offsetTop + 26; }
        else if (host.type === 'overlay' || host.type === 'slide') { cx = (box.w - ww) / 2; cy = Math.max(16, (box.h - wh) / 2 - 40); }
        else { cx = 40; cy = 24; }
        if (host.type !== 'anchor' && (cx + ww > box.w - 8 || cy + wh > box.h - 8)) {
          host.wrap = ((host.wrap || 0) + 1) % 6;
          cx = (host.type === 'desktop' ? 16 : (box.w - ww) / 2 - 60) + host.wrap * 30; cy = 12 + host.wrap * 12;
        }
        if (x == null) x = Math.round(Math.max(0, cx));
        if (y == null) y = Math.round(Math.max(0, cy));
      }
      el.style.left = px(x); el.style.top = px(y);
      el.style.zIndex = ++zTop;
    }

    box() {
      const R = Reveal(), t = this.host.type;
      if (t === 'slide' && R) { const s = R.getComputedSlideSize ? R.getComputedSlideSize() : { width: 960, height: 700 }; return { w: s.width, h: s.height }; }
      if (t === 'overlay') return { w: W.innerWidth, h: W.innerHeight };
      const e = this.host.el;
      return { w: e.clientWidth || (e.parentNode && e.parentNode.clientWidth) || 800, h: e.clientHeight || 600 };
    }

    scale() { return this.el.closest('.reveal .slides') && Reveal() && !this.fs ? Reveal().getScale() || 1 : 1; }

    wire() {
      const el = this.el, bar = this.bar;
      bar.addEventListener('click', e => {
        const b = e.target.closest('.qos-light'); if (!b) return;
        e.stopPropagation();
        if (b.classList.contains('qos-close')) this.close();
        else if (b.classList.contains('qos-min')) this.minimize();
        else this.maximize();
      });
      bar.addEventListener('dblclick', e => { if (!e.target.closest('.qos-light')) this.maximize(); });
      el.addEventListener('pointerdown', () => this.focus(true), true);
      bar.addEventListener('pointerdown', e => this.drag(e));
      // keep typing / scrolling inside windows away from reveal.js & page shortcuts
      ['keydown', 'keyup', 'keypress', 'wheel', 'touchstart', 'touchmove'].forEach(t => el.addEventListener(t, e => e.stopPropagation(), { passive: true }));
      // resize handles
      const dirs = this.floating ? ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] : ['grip'];
      dirs.forEach(d => {
        const g = h('div', 'qos-rs qos-rs-' + d);
        g.addEventListener('pointerdown', e => this.resize(e, d === 'grip' ? 'se' : d));
        el.appendChild(g);
      });
      // resize events
      if (W.ResizeObserver) {
        this.ro = new ResizeObserver(() => this.kick());
        this.ro.observe(this.body);
      }
    }

    kick() {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => {
        this._raf = 0;
        const vis = this.isVisible();
        if (vis && !this.mounted) this.mount();
        if (vis && this.body.clientWidth && this.body.clientHeight) this.emit('resize');
      });
    }

    pointerLoop(e, move, done) {
      e.preventDefault();
      const t = e.currentTarget, id = e.pointerId;
      try { t.setPointerCapture(id); } catch (err) { /* ignore */ }
      const s = this.scale(), x0 = e.clientX, y0 = e.clientY;
      this.el.classList.add('qos-busy');
      const mv = ev => move((ev.clientX - x0) / s, (ev.clientY - y0) / s);
      const up = () => {
        t.removeEventListener('pointermove', mv); t.removeEventListener('pointerup', up); t.removeEventListener('pointercancel', up);
        this.el.classList.remove('qos-busy');
        if (done) done();
      };
      t.addEventListener('pointermove', mv); t.addEventListener('pointerup', up); t.addEventListener('pointercancel', up);
    }

    drag(e) {
      if (e.button !== 0 || e.target.closest('.qos-light') || !this.floating || this.state === 'maximized' || this.fs) return;
      const el = this.el, l0 = el.offsetLeft, t0 = el.offsetTop, box = this.box(), w = el.offsetWidth;
      const free = this.host.type === 'anchor';
      this.pointerLoop(e, (dx, dy) => {
        el.style.left = (free ? l0 + dx : clamp(l0 + dx, 60 - w, box.w - 60)) + 'px';
        el.style.top = (free ? t0 + dy : clamp(t0 + dy, 0, box.h - 32)) + 'px';
      });
    }

    resize(e, d) {
      if (e.button !== 0 || this.state !== 'normal' || this.fs) return;
      e.stopPropagation();
      this.focus(true);
      const el = this.el, r = { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
      const minW = 200, minH = 90;
      const maxW = this.floating ? 1e5 : (el.parentNode.clientWidth || 1e5);
      this.pointerLoop(e, (dx, dy) => {
        if (d.includes('e')) el.style.width = clamp(r.w + dx, minW, maxW) + 'px';
        if (d.includes('s')) el.style.height = Math.max(minH, r.h + dy) + 'px';
        if (d.includes('w')) { const w = Math.max(minW, r.w - dx); el.style.width = w + 'px'; el.style.left = (r.x + r.w - w) + 'px'; }
        if (d.includes('n')) { const hh = Math.max(minH, r.h - dy); el.style.height = hh + 'px'; el.style.top = Math.max(0, r.y + r.h - hh) + 'px'; }
      });
    }

    // -- events
    on(ev, cb) { (this.l[ev] || (this.l[ev] = [])).push(cb); return () => { this.l[ev] = (this.l[ev] || []).filter(f => f !== cb); }; }
    emit(ev, a) { (this.l[ev] || []).slice().forEach(f => { try { f(a); } catch (err) { console.error('[quarto-os]', err); } }); }

    setTitle(t) { this.title = t == null ? '' : String(t); this.titleEl.textContent = this.title; this.titleEl.title = this.title; if (this.desk) this.desk.update(); }

    isVisible() {
      if (this.state === 'closed' || this.state === 'minimized' || !this.el.isConnected) return false;
      const s = slideOf(this.el);
      if (s && !s.classList.contains('present')) return false;
      return this.body.getClientRects().length > 0 && !!this.body.offsetParent;
    }

    // bring to front of its container; the front window of each container looks "active"
    front() {
      if (!this.floating) return;
      if (!this.fs) this.el.style.zIndex = ++zTop;
      windows.forEach(w => { if (w.floating && w.host.el === this.host.el) w.el.classList.toggle('qos-inactive', w !== this); });
    }

    focus(user) {
      if (this.state === 'closed') return;
      this.front();
      this.seq = ++seq;
      if (this.app === 'terminal') QOS.lastTerminal = this;
      if (focused !== this) {
        const prev = focused; focused = this;
        if (prev) { prev.el.classList.remove('qos-focused'); prev.emit('blur'); }
        this.el.classList.add('qos-focused');
        this.emit('focus');
      }
      if (this.desk) this.desk.update();
      if (!user && this.instance && this.instance.focus) { try { this.instance.focus(); } catch (e) { /* ignore */ } }
    }

    // -- traffic lights
    minimize(instant) {
      if (this.state === 'closed') return;
      if (this.fs) this.exitFS();
      if (this.desk) {
        if (this.state === 'minimized') return this.restore();
        this.prevState = this.state;
        this.state = 'minimized';
        const dk = this.desk.minimized(this, true);
        const go = () => { this.el.classList.add('qos-hidden'); this.el.style.transform = ''; this.el.style.opacity = ''; };
        if (instant || !dk) return go();
        const a = this.el.getBoundingClientRect(), b = dk.getBoundingClientRect();
        anim(this.el, [{ transform: 'none', opacity: 1 }, { transform: `translate(${(b.left + b.width / 2) - (a.left + a.width / 2)}px,${(b.top + b.height / 2) - (a.top + a.height / 2)}px) scale(.08)`, opacity: 0.2 }], 260).then(go);
        if (focused === this) { focused = null; this.el.classList.remove('qos-focused'); this.emit('blur'); this.desk.update(); }
        activateNext(this);
        return;
      }
      this.el.classList.toggle('qos-collapsed');
      this.state = this.el.classList.contains('qos-collapsed') ? 'collapsed' : 'normal';
      if (this.state === 'normal') this.kick();
    }

    restore() {
      if (this.state === 'closed' && this.closedBar) return this.reopen();
      if (this.state === 'minimized') {
        this.state = this.prevState === 'maximized' ? 'maximized' : 'normal';
        this.el.classList.remove('qos-hidden');
        const dk = this.desk && this.desk.tile(this);
        if (dk) {
          const a = this.el.getBoundingClientRect(), b = dk.getBoundingClientRect();
          anim(this.el, [{ transform: `translate(${(b.left + b.width / 2) - (a.left + a.width / 2)}px,${(b.top + b.height / 2) - (a.top + a.height / 2)}px) scale(.08)`, opacity: 0.2 }, { transform: 'none', opacity: 1 }], 240);
          this.desk.minimized(this, false);
        }
      } else if (this.state === 'collapsed') { this.el.classList.remove('qos-collapsed'); this.state = 'normal'; }
      this.focus();
      this.kick();
    }

    maximize() {
      if (this.state === 'closed') return;
      if (this.state === 'minimized' || this.state === 'collapsed') this.restore();
      if (this.desk) {
        const on = this.state !== 'maximized';
        this.state = on ? 'maximized' : 'normal';
        this.el.classList.add('qos-anim');
        this.el.classList.toggle('qos-max', on);
        setTimeout(() => { this.el.classList.remove('qos-anim'); this.kick(); }, 260);
        this.focus();
        return;
      }
      if (this.fs) this.exitFS(); else this.enterFS();
    }

    enterFS() {
      const el = this.el;
      this.fs = true;
      el.classList.add('qos-fullscreen');
      if (el.showPopover) { try { el.popover = 'manual'; el.showPopover(); } catch (e) { /* ignore */ } }
      this._esc = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.exitFS(); } };
      D.addEventListener('keydown', this._esc, true);
      D.documentElement.classList.add('qos-has-fullscreen');
      this.focus();
      anim(el, [{ transform: 'scale(.97)', opacity: 0.6 }, { transform: 'none', opacity: 1 }], 180);
      this.kick();
    }

    exitFS() {
      const el = this.el;
      this.fs = false;
      if (el.hidePopover && el.hasAttribute('popover')) { try { el.hidePopover(); } catch (e) { /* ignore */ } el.removeAttribute('popover'); }
      el.classList.remove('qos-fullscreen');
      D.removeEventListener('keydown', this._esc, true);
      if (!windows.some(w => w.fs)) D.documentElement.classList.remove('qos-has-fullscreen');
      this.kick();
    }

    dispose() {
      if (this.instance && this.instance.dispose) { try { this.instance.dispose(); } catch (e) { console.error('[quarto-os]', e); } }
      this.emit('close');
      this.l = {};
      this.instance = null;
      if (focused === this) focused = null;
      this.seq = 0;
      if (QOS.lastTerminal === this) QOS.lastTerminal = recent(windows.filter(w => w !== this && w.app === 'terminal' && w.state !== 'closed'));
    }

    close() {
      if (this.state === 'closed') return;
      if (this.fs) this.exitFS();
      if (!this.floating) {
        // inline windows collapse to a small bar so the document keeps its content
        this.state = 'closed';
        if (this.app !== 'content') { this.dispose(); this.mounted = false; this.body.replaceChildren(); }
        const bar = this.closedBar = h('div', 'qos-closedbar');
        bar.appendChild(icon(this.app));
        bar.appendChild(h('span', '', '<b>' + esc(this.title || this.def.title) + '</b> closed'));
        const b = h('button', 'qos-reopen', 'Reopen');
        b.type = 'button';
        b.onclick = () => this.reopen();
        bar.appendChild(b);
        this.el.before(bar);
        this.el.classList.add('qos-hidden');
        return;
      }
      this.state = 'closed';
      this.dispose();
      activateNext(this);
      const i = windows.indexOf(this); if (i >= 0) windows.splice(i, 1);
      if (this.ro) this.ro.disconnect();
      anim(this.el, [{ transform: 'none', opacity: 1 }, { transform: 'scale(.94)', opacity: 0 }], 160).then(() => {
        this.el.remove();
        if (this.desk) { this.desk.minimized(this, false); this.desk.update(); }
      });
      if (this.desk) this.desk.update();
    }

    reopen() {
      if (!this.closedBar) return;
      this.closedBar.remove(); this.closedBar = null;
      this.el.classList.remove('qos-hidden', 'qos-collapsed');
      this.state = 'normal';
      if (!this.mounted) this.ready = new Promise(r => { this._ready = r; });
      anim(this.el, [{ transform: 'scale(.97)', opacity: 0 }, { transform: 'none', opacity: 1 }], 200);
      this.focus(true);
      this.kick();
    }

    // -- apps
    mount() {
      if (this.mounted) return this.ready;
      this.mounted = true;
      const def = this.def, body = this.body, opts = this.opts;
      const done = inst => { this.instance = inst || {}; this._ready(this.instance); this.emit('mounted'); return this.instance; };
      if (def.mount) {
        try { return Promise.resolve(def.mount(this, opts, QOS)).then(done, err => this.fail(err)); } catch (err) { return this.fail(err); }
      }
      if (!def.module) return this.fail(new Error('Unknown app "' + this.app + '"'));
      body.classList.add('qos-app');
      const ph = h('div', 'qos-placeholder');
      ph.appendChild(icon(this.app));
      ph.appendChild(h('div', 'qos-ph-text', 'Loading ' + esc(def.title) + '…'));
      ph.appendChild(h('div', 'qos-spinner'));
      body.appendChild(ph);
      const drop = () => { if (ph.isConnected) ph.remove(); if (mo) mo.disconnect(); };
      const mo = W.MutationObserver ? new MutationObserver(recs => { if (recs.some(r => Array.from(r.addedNodes).some(n => n !== ph && n.nodeType === 1))) drop(); }) : null;
      return import(new URL(def.module, baseUrl || location.href).href).then(mod => {
        if (this.state === 'closed') return;
        if (mo) mo.observe(body, { childList: true });
        if (!mod || typeof mod.mount !== 'function') throw new Error(def.module + ' does not export mount()');
        return Promise.resolve(mod.mount(this, opts, QOS)).then(inst => { drop(); return done(inst); });
      }).catch(err => { drop(); return this.fail(err); });
    }

    fail(err) {
      console.error('[quarto-os] ' + this.app + ':', err);
      const box = h('div', 'qos-error');
      box.appendChild(icon(this.app));
      box.appendChild(h('div', 'qos-err-title', 'Couldn’t open ' + esc(this.def.title || this.app)));
      box.appendChild(h('div', 'qos-err-msg', esc((err && err.message) || err)));
      this.body.appendChild(box);
      this._ready(null);
      return null;
    }
  }

  // decide how a content window's body is laid out (media edge-to-edge, code flush, prose padded)
  function classifyContent(win) {
    const b = win.body, kids = Array.from(b.children);
    const media = b.querySelectorAll('img,video,iframe,svg,canvas,object');
    const text = (b.textContent || '').replace(/\s+/g, '');
    const capText = $$('figcaption,.figure-caption', b).map(e => e.textContent).join('').replace(/\s+/g, '');
    if (media.length === 1 && text === capText) {
      b.classList.add('qos-media');
      const m = media[0];
      if (win.opts.fit) m.style.objectFit = win.opts.fit;
      const srcEl = m.querySelector && m.querySelector('source') || m;
      const src = srcEl.getAttribute('src') || srcEl.getAttribute('data-src');
      if (src) win.autoTitle = decodeURIComponent(src.split(/[?#]/)[0].split('/').pop());
    } else if (kids.length === 1 && kids[0].matches('div.sourceCode, pre, .code-copy-outer-scaffold, .code-with-filename')) {
      b.classList.add('qos-code');
      const fn = b.querySelector('.code-with-filename-file');
      if (fn) { win.autoTitle = fn.textContent.trim(); fn.classList.add('qos-hidden'); }
    } else b.classList.add('qos-prose');
  }

  // ---------------------------------------------------------------- builtin apps
  function mountContent(win, opts) {
    const c = opts.content;
    if (c != null) {
      if (typeof c === 'string') win.body.innerHTML = c; else win.body.appendChild(c);
      if (!win.body.classList.contains('qos-media')) win.body.classList.add('qos-prose');
    }
    return {};
  }

  function mountBrowser(win, opts) {
    const b = win.body;
    b.classList.add('qos-browser');
    const bar = h('form', 'qos-urlbar',
      '<button type="button" data-a="back" aria-label="Back">‹</button><button type="button" data-a="fwd" aria-label="Forward">›</button>' +
      '<button type="button" data-a="reload" aria-label="Reload">↻</button><input type="text" spellcheck="false" aria-label="Address">' +
      '<a target="_blank" rel="noopener" aria-label="Open in new tab" title="Open in new tab">↗</a>');
    const frame = h('iframe', 'qos-frame');
    frame.setAttribute('credentialless', '');
    frame.setAttribute('allow', 'fullscreen; clipboard-read; clipboard-write');
    frame.setAttribute('referrerpolicy', 'no-referrer-when-downgrade');
    b.append(bar, frame);
    const input = bar.querySelector('input'), link = bar.querySelector('a');
    const hist = []; let pos = -1;
    const norm = u => { u = String(u || '').trim(); if (!u) return 'about:blank'; return /^[a-z][\w+.-]*:/i.test(u) || u.startsWith('/') || u.startsWith('.') ? u : 'https://' + u; };
    const show = u => {
      frame.src = u; input.value = u === 'about:blank' ? '' : u; link.href = u;
      if (!win.opts.title) { try { win.setTitle(new URL(u, location.href).host || 'Browser'); } catch (e) { win.setTitle(u); } }
    };
    const go = u => { u = norm(u); hist.splice(pos + 1); hist.push(u); pos = hist.length - 1; show(u); };
    bar.addEventListener('submit', e => { e.preventDefault(); go(input.value); });
    bar.addEventListener('click', e => {
      const a = e.target.closest('button'); if (!a) return;
      const k = a.dataset.a;
      if (k === 'back' && pos > 0) show(hist[--pos]);
      else if (k === 'fwd' && pos < hist.length - 1) show(hist[++pos]);
      else if (k === 'reload') { const s = frame.src; frame.src = 'about:blank'; setTimeout(() => { frame.src = s; }, 30); }
    });
    go(opts.url || 'about:blank');
    return { navigate: go, focus() { input.focus(); } };
  }

  // ---------------------------------------------------------------- desktop
  const MENUS = ['File', 'Edit', 'View', 'Window', 'Help'];
  const LOGO = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.2c.5 3.4 2.4 5.3 5.8 5.8-3.4.5-5.3 2.4-5.8 5.8-.5-3.4-2.4-5.3-5.8-5.8C5.6 6.5 7.5 4.6 8 1.2z"/><circle cx="13" cy="13" r="1.6"/></svg>';
  const STATUS = '<svg viewBox="0 0 20 14" aria-hidden="true"><path d="M10 12.6l2.3-2.6a3.4 3.4 0 0 0-4.6 0zM5.4 7.9l1.3 1.4a4.8 4.8 0 0 1 6.6 0l1.3-1.4a6.7 6.7 0 0 0-9.2 0zM2.6 5l1.3 1.4a8.8 8.8 0 0 1 12.2 0L17.4 5a10.7 10.7 0 0 0-14.8 0z"/></svg>' +
    '<svg viewBox="0 0 26 14" aria-hidden="true"><rect x=".75" y="1.75" width="21.5" height="10.5" rx="3" fill="none" stroke="currentColor" stroke-opacity=".55" stroke-width="1.2"/><rect x="2.4" y="3.4" width="15" height="7.2" rx="1.6"/><path d="M23.5 5.2v3.6c.8-.3 1.3-1 1.3-1.8s-.5-1.5-1.3-1.8z" fill-opacity=".55"/></svg>';

  class Desktop {
    constructor(el) {
      const o = this.opts = opt(el);
      this.el = el; el.qosDesk = this;
      el.classList.add('qos-ready');
      el.style.height = px(o.height || '480px');
      if (o.width) el.style.width = px(o.width);
      if (o.wallpaper) el.style.setProperty('--qos-wallpaper', /gradient\(|^#|^rgb|^hsl|^var\(/.test(o.wallpaper) ? o.wallpaper : 'url("' + o.wallpaper + '") center / cover no-repeat');
      if ((o.theme || config.theme) === 'dark') el.classList.add('qos-desk-dark');
      const kids = Array.from(el.children);
      const screen = this.screen = h('div', 'qos-screen');
      const extra = h('div', 'qos-desk-content');
      kids.forEach(k => { if (!k.classList.contains('qos-window')) extra.appendChild(k); });
      if (extra.childNodes.length) screen.appendChild(extra);
      this.hasMenubar = o.menubar == null || yes(o.menubar);
      if (!this.hasMenubar) el.classList.add('qos-nomenubar');
      if (this.hasMenubar) {
        const mb = this.menubar = h('div', 'qos-menubar',
          '<span class="qos-mb-logo">' + LOGO + '</span><b class="qos-mb-app"></b>' + MENUS.map(m => '<span class="qos-mb-menu">' + m + '</span>').join('') +
          '<span class="qos-mb-right"><span class="qos-mb-status"></span>' + STATUS + '<span class="qos-mb-clock"></span></span>');
        el.appendChild(mb);
      }
      el.appendChild(screen);
      this.host = { type: 'desktop', el: screen, desk: this };
      this.buildDock();
      kids.forEach(k => { if (k.classList.contains('qos-window')) new Win(k, opt(k), this.host); });
      desktops.push(this);
      // the last window in source order is in front
      const ws = this.wins().filter(w => w.state !== 'minimized');
      if (ws.length) ws[ws.length - 1].front();
      this.update();
      tick();
    }

    wins() { return windows.filter(w => w.desk === this && w.state !== 'closed'); }

    buildDock() {
      const list = (this.opts.dock == null ? 'terminal,vscode,explorer' : this.opts.dock).split(/[\s,]+/).filter(Boolean);
      if (!list.length && this.opts.dock != null) { this.dockEl = null; return; }
      const dock = this.dockEl = h('div', 'qos-dock');
      const appsBox = h('div', 'qos-dock-apps'), minBox = this.minBox = h('div', 'qos-dock-min');
      this.items = {};
      list.forEach(a => {
        const it = h('button', 'qos-dock-item');
        it.type = 'button';
        it.dataset.app = a;
        it.setAttribute('aria-label', 'Open ' + (apps[a] ? apps[a].title : a));
        it.appendChild(icon(a));
        it.appendChild(h('span', 'qos-tip', esc(apps[a] ? apps[a].title : a)));
        it.appendChild(h('span', 'qos-dot'));
        it.addEventListener('click', () => {
          anim(it.firstChild, [{ transform: 'translateY(0)' }, { transform: 'translateY(-22%)' }, { transform: 'translateY(0)' }], 420);
          QOS.open(a, { target: this.el });
        });
        appsBox.appendChild(it);
        this.items[a] = it;
      });
      dock.append(appsBox, h('div', 'qos-dock-sep'), minBox);
      this.el.appendChild(dock);
      // magnification
      dock.addEventListener('pointermove', e => {
        if (reduced() || e.pointerType === 'touch') return;
        const s = (Reveal() && dock.closest('.reveal .slides')) ? Reveal().getScale() : 1;
        $$('.qos-dock-item', dock).forEach(it => {
          const r = it.getBoundingClientRect();
          const d = Math.abs(e.clientX - (r.left + r.width / 2)) / s;
          const base = it.offsetHeight || 46;
          const k = Math.max(0, 1 - d / (base * 2.6));
          it.style.setProperty('--qos-mag', (1 + 0.55 * (1 - Math.cos(k * Math.PI)) / 2).toFixed(3));
        });
      });
      dock.addEventListener('pointerleave', () => $$('.qos-dock-item', dock).forEach(it => it.style.removeProperty('--qos-mag')));
    }

    tile(win) { return this.dockEl ? this.minBox.querySelector('[data-win="' + win.id + '"]') : null; }

    // add/remove a minimized window's dock tile; returns the tile
    minimized(win, add) {
      if (!this.dockEl) return null;
      let t = this.tile(win);
      if (add && !t) {
        t = h('button', 'qos-dock-item qos-dock-mini');
        t.type = 'button';
        t.dataset.win = win.id;
        t.setAttribute('aria-label', 'Restore ' + (win.title || win.def.title));
        t.appendChild(icon(win.app));
        t.appendChild(h('span', 'qos-tip', esc(win.title || win.def.title)));
        t.addEventListener('click', () => win.restore());
        this.minBox.appendChild(t);
        anim(t, [{ transform: 'scale(.3)', opacity: 0 }, { transform: 'none', opacity: 1 }], 220);
      } else if (!add && t) t.remove();
      this.update();
      return t;
    }

    update() {
      const ws = this.wins();
      if (this.items) Object.keys(this.items).forEach(a => this.items[a].classList.toggle('qos-running', ws.some(w => w.app === a)));
      if (this.menubar) {
        const f = focused && focused.desk === this && focused.state !== 'minimized' ? focused : null;
        this.menubar.querySelector('.qos-mb-app').textContent = f ? f.def.title : (this.opts.title || 'Desktop');
      }
      if (this.dockEl) this.dockEl.classList.toggle('qos-has-min', this.minBox.children.length > 0);
    }
  }

  let clockTimer = 0;
  function tick() {
    const s = new Date().toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).replace(/,/g, '');
    $$('.qos-mb-clock').forEach(c => { c.textContent = s; });
    if (!clockTimer) clockTimer = setInterval(tick, 15000);
  }

  // ---------------------------------------------------------------- hosts & open()
  function getOverlay() {
    if (!overlay || !overlay.isConnected) { overlay = h('div', 'qos-overlay'); D.body.appendChild(overlay); }
    return { type: 'overlay', el: overlay };
  }

  function hostFor(target, origin) {
    if (target && target instanceof Win) { origin = target.el; target = null; }
    if (typeof target === 'string' && target) {
      const t = D.getElementById(target.replace(/^#/, ''));
      if (!t) console.warn('[quarto-os] target not found: ' + target);
      target = t;
    }
    if (target && target.nodeType === 1) {
      if (target.qosDesk) return target.qosDesk.host;
      if (target.qosWin) origin = target;
      else if (slideOf(target) === target || target.matches('.reveal .slides section')) return { type: 'slide', el: target };
      else origin = target;
    }
    if (origin) {
      const dk = origin.closest('.qos-desktop');
      if (dk && dk.qosDesk) return dk.qosDesk.host;
      if (origin.qosWin && origin.qosWin.host.type === 'overlay') return origin.qosWin.host;
      const s = slideOf(origin);
      if (s) {
        const inSlide = desktops.filter(d => slideOf(d.el) === s);
        return inSlide.length === 1 ? inSlide[0].host : { type: 'slide', el: s };
      }
    }
    if (desktops.length === 1) return desktops[0].host;
    return getOverlay();
  }

  function open(app, opts) {
    opts = Object.assign({}, opts || {}, { app: app || (opts && opts.app) || 'content' });
    const origin = opts.origin; delete opts.origin;
    const host = hostFor(opts.target, origin);
    delete opts.target;
    const el = h('div');
    if (opts.id) { el.id = opts.id; delete opts.id; }
    host.el.appendChild(el);
    const win = new Win(el, opts, host);
    anim(el, [{ transform: 'scale(.94)', opacity: 0 }, { transform: 'none', opacity: 1 }], 200);
    win.focus(true);
    if (host.desk) host.desk.update();
    if (host.type === 'desktop' && !inView(host.desk.el)) host.desk.el.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'nearest' });
    const p = win.mount();
    return Promise.resolve(p).then(() => { win.focus(); return win; });
  }

  function inView(el) { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; }

  // ---------------------------------------------------------------- run snippets
  function run(text, target, origin) {
    text = String(text == null ? '' : text).replace(/\s+$/, '');
    let win = null, host = null;
    if (target) {
      const t = D.getElementById(String(target).replace(/^#/, ''));
      if (t && t.qosWin) win = t.qosWin;
      else if (t && t.qosDesk) host = t;
      else console.warn('[quarto-os] run target not found: ' + target);
    }
    if (!win && !host) {
      const terms = windows.filter(w => w.app === 'terminal' && w.state !== 'closed');
      const s = origin && slideOf(origin);
      const lt = alive(QOS.lastTerminal) ? QOS.lastTerminal : recent(terms);
      if (s) {
        const here = terms.filter(w => slideOf(w.el) === s);
        win = lt && here.includes(lt) ? lt : here[here.length - 1] || null;
      } else win = lt || (terms.length === 1 ? terms[0] : null);
    }
    const go = w => {
      if (w.state === 'minimized' || w.state === 'collapsed' || w.closedBar) w.restore();
      if (!w.floating && !inView(w.el)) w.el.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'center' });
      w.focus();
      w.mount();
      return w.ready.then(inst => {
        if (inst && inst.run) inst.run(text); else console.warn('[quarto-os] window ' + w.id + ' cannot run commands');
        return w;
      });
    };
    if (win) return go(win);
    return open('terminal', { target: host || undefined, origin }).then(go);
  }

  function runText(el) {
    const pre = el.matches('pre') ? el : el.querySelector('pre');
    const code = (pre || el).querySelector('code') || pre || el;
    return code.textContent;
  }

  function setupRun(el) {
    if (el.qosRun) return;
    el.qosRun = true;
    if (el.matches('code')) {
      el.setAttribute('role', 'button'); el.tabIndex = 0;
      el.title = 'Run in terminal';
      return;
    }
    const pre = el.matches('pre') ? el : el.querySelector('pre');
    if (!pre) return;
    const scaffold = pre.closest('.code-copy-outer-scaffold') || pre.closest('div.sourceCode') || pre.parentNode;
    scaffold.classList.add('qos-run-wrap');
    const b = h('button', 'qos-runbtn', 'Run <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 1.5v7l6-3.5z"/></svg>');
    b.type = 'button';
    b.title = 'Run in terminal';
    scaffold.appendChild(b);
  }

  function flash(el) { el.classList.remove('qos-flash'); void el.offsetWidth; el.classList.add('qos-flash'); }

  function runTarget(el) {
    const t = el.closest('[data-qos-target]');
    return t ? t.getAttribute('data-qos-target') : null;
  }

  // ---------------------------------------------------------------- loaders & VM
  const loaded = {};
  let amdHidden = 0, amdSaved;
  function loadScript(url) {
    url = new URL(url, baseUrl || location.href).href;
    if (loaded[url]) return loaded[url];
    return (loaded[url] = new Promise((res, rej) => {
      const s = D.createElement('script');
      s.src = url; s.async = true;
      if (!amdHidden++) { amdSaved = W.define; W.define = undefined; }
      const fin = ok => () => {
        if (!--amdHidden && W.define === undefined && amdSaved !== undefined) W.define = amdSaved;
        if (ok) res(); else { delete loaded[url]; rej(new Error('Failed to load ' + url)); }
      };
      s.onload = fin(true); s.onerror = fin(false);
      D.head.appendChild(s);
    }));
  }
  function loadCSS(url) {
    url = new URL(url, baseUrl || location.href).href;
    if (loaded[url]) return loaded[url];
    return (loaded[url] = new Promise((res, rej) => {
      const l = D.createElement('link');
      l.rel = 'stylesheet'; l.href = url;
      l.onload = () => res(l); l.onerror = () => { delete loaded[url]; rej(new Error('Failed to load ' + url)); };
      D.head.appendChild(l);
    }));
  }

  let vmP = null;
  function vm() {
    if (vmP) return vmP;
    vmP = import(baseUrl + 'vm/vm.js').then(m => m.createVM(config.vm || {}, { baseUrl }));
    vmP.then(v => {
      if (!v || !v.on) return;
      const st = s => $$('.qos-mb-status').forEach(e => { e.textContent = s; e.classList.toggle('qos-on', !!s); });
      v.on('status', s => st(String(s || '')));
      if (v.ready && v.ready.then) v.ready.then(() => setTimeout(() => st(''), 1200), e => st('VM error'));
    }, () => { vmP = null; });
    return vmP;
  }

  // ---------------------------------------------------------------- cross-origin isolation (GitHub Pages)
  function coi() {
    const K = 'qos-coi-reload';
    let ss = null;
    try { ss = W.sessionStorage; } catch (e) { /* ignore */ }
    if (W.crossOriginIsolated) { if (ss) ss.removeItem(K); return; }
    if (!config.usesVM || config.coi === false || !('serviceWorker' in NAV) || !W.isSecureContext) return;
    const reload = () => {
      if (ss && ss.getItem(K)) { console.warn('[quarto-os] page is still not cross-origin isolated; the Linux VM may not start.'); return; }
      if (ss) ss.setItem(K, '1');
      location.reload();
    };
    const cred = !!(W.chrome || W.netscape); // Chromium & Firefox support COEP: credentialless
    NAV.serviceWorker.register(new URL('coi-serviceworker.js' + (cred ? '?coep=credentialless' : ''), location.href).href).then(reg => {
      if (reg.active && !NAV.serviceWorker.controller) reload();
      else if (!reg.active) NAV.serviceWorker.addEventListener('controllerchange', reload, { once: true });
    }, err => console.warn('[quarto-os] could not register coi-serviceworker.js:', err));
  }

  // ---------------------------------------------------------------- init
  function readConfig() {
    const c = D.getElementById('quarto-os-config');
    try { return c ? JSON.parse(c.textContent || '{}') : {}; } catch (e) { console.error('[quarto-os] bad config', e); return {}; }
  }

  let io = null;
  function initWindow(el) {
    if (el.qosWin || el.closest('.qos-desktop:not(.qos-ready)')) return;
    const o = opt(el);
    let host = { type: 'inline', el: el.parentNode };
    if (yes(o.float) || o.x != null || o.y != null) {
      const s = slideOf(el);
      if (s) host = { type: 'slide', el: s };
      else {
        const a = h('div', 'qos-anchor');
        el.before(a);
        host = { type: 'anchor', el: a };
      }
    }
    const w = new Win(el, o, host);
    if (io) io.observe(w.el); else w.kick();
  }

  function refresh() { windows.forEach(w => w.kick()); }

  // does anything on the page need the VM? (the Lua filter can't see shortcodes, so check the DOM too)
  function pageUsesVM() {
    const vmApp = a => !!(apps[a] && apps[a].vm);
    return $$('.qos-window, .qos-launch').some(e => vmApp(opt(e).app || (e.classList.contains('qos-launch') ? 'terminal' : 'content'))) ||
      $$('.qos-desktop').some(e => { const d = opt(e).dock; return (d == null ? 'terminal' : d).split(/[\s,]+/).some(vmApp); }) ||
      !!D.querySelector('.qos-run');
  }

  function init() {
    config = QOS.config = readConfig();
    if (!config.usesVM && pageUsesVM()) config.usesVM = true;
    coi();
    if (W.IntersectionObserver) {
      io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting && e.target.qosWin) e.target.qosWin.kick(); }), { rootMargin: '200px' });
    }
    $$('.qos-desktop').forEach(el => { if (!el.qosDesk) new Desktop(el); });
    windows.forEach(w => io ? io.observe(w.el) : w.kick());
    $$('.qos-window').forEach(initWindow);
    $$('.qos-run').forEach(setupRun);
    $$('.qos-launch').forEach(l => l.style.setProperty('--qos-launch-icon', 'url("' + QOS.icon(opt(l).app || 'terminal') + '")'));

    D.addEventListener('click', e => {
      const l = e.target.closest('.qos-launch');
      if (l) {
        e.preventDefault();
        const o = opt(l);
        open(o.app || 'terminal', Object.assign({}, o, { origin: l })).catch(err => console.error('[quarto-os]', err));
        return;
      }
      const rb = e.target.closest('.qos-runbtn');
      if (rb) { const pre = rb.parentNode.querySelector('pre.qos-run, pre'); flash(rb.parentNode); run(runText(pre), runTarget(pre), rb); return; }
      const rc = e.target.closest('code.qos-run');
      if (rc && !rc.closest('pre')) { flash(rc); run(rc.textContent, runTarget(rc), rc); }
    });
    D.addEventListener('keydown', e => {
      const rc = e.target.closest && e.target.closest('code.qos-run');
      if (rc && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); run(rc.textContent, runTarget(rc), rc); }
    });

    const R = Reveal();
    if (R && R.on) {
      ['ready', 'slidechanged', 'resize', 'overviewhidden', 'fragmentshown'].forEach(ev => R.on(ev, () => setTimeout(refresh, 30)));
      R.on('slidechanged', () => windows.forEach(w => { if (w.fs && !w.isVisible()) w.exitFS(); }));
    }
    W.addEventListener('load', refresh);
    if (config.vm && config.vm.autoboot) vm().catch(err => console.error('[quarto-os] VM', err));
    D.dispatchEvent(new CustomEvent('quarto-os:ready', { detail: QOS }));
  }

  const QOS = W.QuartoOS = {
    version: '0.1.0',
    config, baseUrl, apps, windows, desktops,
    lastTerminal: null,
    open, vm, loadScript, loadCSS,
    run: (text, target) => run(text, target),
    icon: app => svgUrl((apps[app] || apps.content).icon),
    Win
  };

  if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', init); else init();
})();
