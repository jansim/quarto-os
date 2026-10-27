import assert from 'node:assert/strict';
import test from 'node:test';
import {sourceIndex} from './source-links.mjs';
const inventory = 'bash=5.2.15-2\nlinux=1:6.1.0-1\n';
const files = (name, version) => `# ${name}=${version}
'http://deb.debian.org/debian/pool/main/${name[0]}/${name}/${name}_1.dsc' ${name}_1.dsc 12 SHA256:abcd
'http://deb.debian.org/debian/pool/main/${name[0]}/${name}/${name}_1.orig.tar.xz' ${name}_1.orig.tar.xz 123 SHA256:1234`;

test('links retain exact source versions, archive filenames and APT checksums', () => {
  const sources = sourceIndex(inventory, files('bash','5.2.15-2') + '\n' + files('linux','1:6.1.0-1'));
  assert.equal(sources.length,2);
  assert.equal(sources[1].version,'1:6.1.0-1');
  assert.equal(sources[1].archive,'https://snapshot.debian.org/package/linux/1%3A6.1.0-1/');
  assert.deepEqual(sources[0].files[0], {
    url:'https://deb.debian.org/debian/pool/main/b/bash/bash_1.dsc', name:'bash_1.dsc', bytes:12, checksum:'SHA256:abcd',
  });
});

test('missing or incomplete source entries fail publication', () => {
  assert.throws(() => sourceIndex(inventory,files('bash','5.2.15-2')),/Incomplete source links for linux/);
  assert.throws(() => sourceIndex('bash=5.2.15-2',files('bash','5.2.15-2').split('\n').slice(0,2).join('\n')),/Incomplete source links/);
});

test('unknown packages and malformed URI metadata fail publication', () => {
  assert.throws(() => sourceIndex('bash=5.2.15-2',files('linux','1:6.1.0-1')),/Unknown source package/);
  assert.throws(() => sourceIndex('bash=5.2.15-2','# bash=5.2.15-2\nnot a download entry'),/Invalid source URI/);
});
