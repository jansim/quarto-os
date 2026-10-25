// STUB VM for core tests only.
export async function createVM(config, { baseUrl }) {
  const l = {};
  const emit = (e, v) => (l[e] || []).forEach(f => f(v));
  const vm = { home: '/home/user', config, baseUrl, on(e, cb) { (l[e] || (l[e] = [])).push(cb); } };
  window.__vmCreated = (window.__vmCreated || 0) + 1;
  vm.ready = (async () => {
    for (const s of ['Downloading CheerpX…', 'Booting Linux…', 'Starting agent…']) { emit('status', s); await new Promise(r => setTimeout(r, 500)); }
    emit('status', 'Ready');
  })();
  return vm;
}
