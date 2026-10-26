// Shared browser tooling for development suites; prepare.sh installs the default.
const module = process.env.PLAYWRIGHT_MODULE || new URL('./v86/out/node_modules/playwright/index.mjs', import.meta.url).href;
const {chromium: original} = await import(module);
export const chromium = new Proxy(original, {
  get(target, key) {
    if (key === 'launch') return (options = {}) => target.launch({
      ...options, ...(process.env.CHROMIUM_PATH ? {executablePath: process.env.CHROMIUM_PATH} : {}),
    });
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
