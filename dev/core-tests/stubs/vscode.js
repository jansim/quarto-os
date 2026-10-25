// STUB code editor app for core tests only.
export async function mount(win, opts, os) {
  await new Promise(r => setTimeout(r, 1500));
  win.body.innerHTML = '<div style="display:flex;height:100%;font:13px system-ui"><div style="width:48px;background:#2c2c2c"></div><div style="width:180px;background:#252526;color:#ccc;padding:8px">EXPLORER<br>README.md</div><div style="flex:1;background:#1e1e1e;color:#d4d4d4;padding:8px;font-family:monospace">// ' + (opts.open || 'untitled') + '</div></div>';
  return { dispose() {} };
}
