// STUB explorer app for core tests only: always fails, to test the error path.
export async function mount(win, opts, os) {
  await new Promise(r => setTimeout(r, 300));
  throw new Error('Stub explorer failed on purpose');
}
