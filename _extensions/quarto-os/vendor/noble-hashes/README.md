# SHA-256 fallback

Vendored from `@noble/hashes@2.0.1` (MIT):
https://github.com/paulmillr/noble-hashes/tree/2.0.1

These four ES modules provide SHA-256 when Web Crypto is unavailable
on HTTP origins. They are loaded only on that fallback path. License notices are
retained in the source files and LICENSE. Only trailing whitespace is normalized; source maps are omitted.

To refresh, install the exact package version with npm and copy `sha2.js`,
`_md.js`, `_u64.js`, `utils.js`, and `LICENSE` from the verified package.
