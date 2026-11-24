// Builds vm-assets/: the unkernel runtime, the guest image and Monaco.
//
//   npm ci --prefix dev/vm
//   node dev/vm/build.mjs [--packages "python3 nano"] [--out vm-assets]
//
// The guest is unkernel's Alpine image plus bash and git (and --packages),
// set up inside unkernel itself with apk. Only Node 24+ and network access are
// needed. The kernel reads zstd-compressed erofs: with a host mkfs.erofs that
// has zstd (erofs-utils >= 1.8; or MKFS_EROFS=path) the image is about 3x
// smaller, otherwise the guest packs it uncompressed (fine for offline builds).
import { createKernel, fetchDistro, directBackend, nodeFs } from 'unkernel';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const here = path.dirname(new URL(import.meta.url).pathname);
const out = path.resolve(arg('out', path.join(here, '../../vm-assets')));
const packages = ['bash', 'git', 'ncurses-terminfo-base', ...arg('packages', '').split(/\s+/).filter(Boolean)];
const version = async name => JSON.parse(await readFile(path.join(here, 'node_modules', name, 'package.json'), 'utf8')).version;
const dist = path.join(here, 'node_modules/unkernel/dist');
const mkfs = process.env.MKFS_EROFS || 'mkfs.erofs';
const zstd = /zstd/.test(spawnSync(mkfs, ['--help'], { encoding: 'utf8' }).stdout || '');

await rm(out, { recursive: true, force: true });
await mkdir(path.join(out, 'unkernel/_chunks'), { recursive: true });

// --- guest image ---------------------------------------------------------
const vm = await createKernel({
  distro: await fetchDistro('alpine'), memoryMiB: 2048, net: directBackend(),
  mounts: { '/out': nodeFs(out) }, log: () => {},
});
const sh = async (what, script) => {
  const t = performance.now();
  const r = await vm.exec('/bin/sh', ['-ec', script], { user: 'root', timeout: 1800000 });
  console.log(`${what}: ${((performance.now() - t) / 1000).toFixed(1)} s`);
  if (r.exitCode) throw new Error(`${what} failed (${r.exitCode}):\n${r.stdout}${r.stderr}`);
};
// Packages come over plain HTTP (apk verifies their signatures); the image keeps HTTPS.
const repos = `main=$(head -n1 /etc/apk/repositories); main=http:\${main#https:}; set -- -X "$main" -X "\${main%/main}/community"`;
await sh('install packages', `${repos}
  apk add -q --no-cache --repositories-file /dev/null "$@" ${packages.join(' ')}
  sed -i 's|^\\(user:.*:\\)/bin/[a-z]*sh$|\\1/bin/bash|' /etc/passwd
  printf '[user]\\n\\tname = Student\\n\\temail = student@example.com\\n' > /etc/gitconfig
  echo quarto-os-$(date -u +%Y%m%d%H%M%S) > /usr/lib/kw-image
  apk list -I 2>/dev/null | sort > /out/packages.txt`);
// The image is the distro plus this boot's changes, without the kernel's own layer.
await sh('stage root', `mkdir -p /run/m
  mount -t overlay -o ro,lowerdir=/run/kw-lower/kw/tmp/upper:/run/kw-lower/kw/distro none /run/m
  tar -C /run/m --exclude='./var/cache/apk/*' -cf /out/root.tar . && umount /run/m`);
const erofs = '-Efragments,dedupe -T0 -L kwroot --tar=f';
if (!zstd) {
  console.warn(`${mkfs} has no zstd: packing an uncompressed image (install erofs-utils >= 1.8 for a smaller one)`);
  await sh('pack image', `${repos}
    apk add -q --no-cache --repositories-file /dev/null "$@" erofs-utils
    mkfs.erofs ${erofs} /out/guest.erofs /out/root.tar >/dev/null`);
}
await vm.stop();
if (zstd) {
  const r = spawnSync(mkfs, [...`-zzstd,level=15 ${erofs}`.split(' '), path.join(out, 'guest.erofs'), path.join(out, 'root.tar')], { encoding: 'utf8' });
  if (r.status) throw new Error(`${mkfs} failed:\n${r.stderr}`);
}
await rm(path.join(out, 'root.tar'));

const image = await readFile(path.join(out, 'guest.erofs'));
const imageName = `guest-${createHash('sha256').update(image).digest('hex').slice(0, 12)}.erofs`;
await rename(path.join(out, 'guest.erofs'), path.join(out, imageName));

// --- runtime and editor ----------------------------------------------------
await cp(path.join(dist, 'web.mjs'), path.join(out, 'unkernel/web.mjs'));
await cp(path.join(dist, '_chunks/core.mjs'), path.join(out, 'unkernel/_chunks/core.mjs'));
await writeFile(path.join(out, 'unkernel/unkernel.wasm.gz'), gzipSync(await readFile(path.join(dist, 'unkernel.wasm')), { level: 9 }));
for (const f of ['LICENSE', 'LICENSE-MIT', 'THIRD-PARTY.md']) await cp(path.join(dist, '..', f), path.join(out, 'unkernel', f));
await cp(path.join(here, 'node_modules/monaco-editor/min/vs'), path.join(out, 'monaco/vs'), { recursive: true });
await cp(path.join(here, 'node_modules/monaco-editor/LICENSE'), path.join(out, 'monaco/LICENSE'));

const [unkernel, monaco] = [await version('unkernel'), await version('monaco-editor')];
await writeFile(path.join(out, 'manifest.json'), JSON.stringify({ unkernel, image: imageName, monaco }, null, 2) + '\n');
await writeFile(path.join(out, 'SOURCES.txt'), `Quarto OS VM assets

unkernel ${unkernel} (kernel and SDK: MIT AND GPL-2.0-only)
  https://github.com/pithings/unkernel  ·  npm: unkernel@${unkernel}
Guest: Alpine Linux packages (each under its own license), listed in packages.txt.
  Sources: https://gitlab.alpinelinux.org/alpine/aports (the APKBUILD of each package
  names its upstream source); built by dev/vm/build.mjs in https://github.com/jansim/quarto-os
Monaco Editor ${monaco} (MIT): https://github.com/microsoft/monaco-editor
`);
console.log(`${out}: ${imageName} (${(image.length / 1048576).toFixed(1)} MiB)`);
process.exit(0);
