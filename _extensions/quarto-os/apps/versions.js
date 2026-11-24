// Pinned browser dependencies, shared by their loaders and About Quarto OS.
// dev/vm/package.json pins the same versions for the VM assets.
export const UNKERNEL_VERSION = '0.2.0-261124-c08e977';
export const MONACO_VERSION = '0.52.2';
export const XTERM_VERSION = '6.0.0';
// Default vm.asset-base: the unkernel runtime, guest image and Monaco.
export const ASSET_BASE = 'https://jansim.github.io/quarto-os/vm-assets/';
