import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import {sha256Hex} from '../../_extensions/quarto-os/vm/sha256.js';

for (const [name,provider] of [['Web Crypto',webcrypto],['HTTP fallback',{}]]) {
  test(`SHA-256 cache identity using ${name}`,async()=>{
    const descriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto');
    Object.defineProperty(globalThis,'crypto',{configurable:true,value:provider});
    try {
      assert.equal(await sha256Hex(new TextEncoder().encode('abc')),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
      const vectors=[new Uint8Array(0),new Uint8Array(1000000).fill(97),new Uint8Array([1,2,3,4,5]).subarray(1,4)];
      for(const bytes of vectors) {
        const expected=createHash('sha256').update(bytes).digest('hex');
        assert.equal(await sha256Hex(bytes),expected);
        assert.equal(await sha256Hex(bytes.slice().buffer),expected);
      }
    } finally {
      if(descriptor)Object.defineProperty(globalThis,'crypto',descriptor);
      else delete globalThis.crypto;
    }
  });
}
