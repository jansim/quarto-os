// Preserve identical cache identities on HTTPS/localhost and ordinary HTTP.
export async function sha256Hex(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let digest;
  if (globalThis.crypto?.subtle) {
    digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  } else {
    const {sha256} = await import('../vendor/noble-hashes/sha2.js');
    digest = sha256(bytes);
  }
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
