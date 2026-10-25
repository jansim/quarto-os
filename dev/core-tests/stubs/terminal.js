// STUB terminal app for core tests only.
export async function mount(win, opts, os) {
  await new Promise(r => setTimeout(r, 400));
  const pre = document.createElement('pre');
  pre.className = 'stub-term';
  pre.style.cssText = 'margin:0;padding:8px 10px;height:100%;box-sizing:border-box;overflow:auto;background:#1e1e1e;color:#e6e6e6;font:13px/1.4 ui-monospace,Menlo,monospace;white-space:pre-wrap;border:0;border-radius:0;box-shadow:none;width:auto;max-height:none;font-size:13px';
  pre.textContent = `stub terminal (${win.id}) cwd=${opts.cwd || '~'}\n`;
  win.body.appendChild(pre);
  const log = s => { pre.textContent += s; pre.scrollTop = 1e9; };
  window.__events = window.__events || [];
  win.on('resize', () => { window.__events.push(['resize', win.id, win.body.clientWidth, win.body.clientHeight]); });
  win.on('focus', () => window.__events.push(['focus', win.id]));
  win.on('blur', () => window.__events.push(['blur', win.id]));
  win.on('close', () => window.__events.push(['close', win.id]));
  const vm = await os.vm();
  vm.on('status', s => log('[vm] ' + s + '\n'));
  await vm.ready;
  log('user@quarto-os:~$ ');
  if (opts.run) log(opts.run + '\n(ran)\nuser@quarto-os:~$ ');
  return {
    run(text) { log(text + '\n(ran)\nuser@quarto-os:~$ '); window.__events.push(['run', win.id, text]); },
    focus() { window.__events.push(['instfocus', win.id]); },
    dispose() { window.__events.push(['dispose', win.id]); },
  };
}
