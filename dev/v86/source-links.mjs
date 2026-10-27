// Publish exact Debian source links from APT metadata, without mirroring archives.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export function sourceIndex(inventory, uris) {
  const packages = new Map(inventory.trim().split('\n').map(line => {
    const match = /^([^=\s]+)=(\S+)$/.exec(line);
    if (!match) throw new Error(`Invalid source inventory entry: ${line}`);
    return [line, {name:match[1], version:match[2], files:[]}];
  }));
  let current;
  for (const line of uris.trim().split('\n')) {
    if (line.startsWith('# ')) {
      current = packages.get(line.slice(2));
      if (!current) throw new Error(`Unknown source package: ${line}`);
      continue;
    }
    const match = /^'([^']+)' (\S+) (\d+) ([A-Za-z0-9]+:[a-fA-F0-9]+)$/.exec(line);
    if (!current || !match) throw new Error(`Invalid source URI entry: ${line}`);
    const url = new URL(match[1]);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid source URL protocol');
    // The standard Debian mirrors serve the same pool files over HTTPS.
    if (url.protocol === 'http:' && ['deb.debian.org', 'security.debian.org'].includes(url.hostname))
      url.protocol = 'https:';
    current.files.push({url:url.href, name:match[2], bytes:Number(match[3]), checksum:match[4]});
  }
  for (const source of packages.values()) {
    if (!source.files.some(file => file.name.endsWith('.dsc')) ||
        !source.files.some(file => /\.(?:tar\.(?:gz|xz|bz2|lzma)|diff\.gz)$/.test(file.name)))
      throw new Error(`Incomplete source links for ${source.name}=${source.version}`);
    source.archive = `https://snapshot.debian.org/package/${encodeURIComponent(source.name)}/${encodeURIComponent(source.version)}/`;
  }
  return [...packages.values()];
}

const escape = value => String(value).replace(/[&<>"']/g, character =>
  ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[character]));

async function publish(directory) {
  const sources = sourceIndex(
    await fs.readFile(path.join(directory, 'source-packages.txt'), 'utf8'),
    await fs.readFile(path.join(directory, 'source-uris.txt'), 'utf8'),
  );
  const rows = sources.map(source => `<tr><td>${escape(source.name)}</td><td>${escape(source.version)}</td><td><ul>${source.files.map(file =>
    `<li><a href="${escape(file.url)}">${escape(file.name)}</a> (${file.bytes} bytes)<br><code>${escape(file.checksum)}</code></li>`).join('')}</ul>
<a href="${escape(source.archive)}">Archived source version at Debian Snapshot</a></td></tr>`).join('\n');
  await fs.writeFile(path.join(directory, 'debian-sources.json'), JSON.stringify(sources, null, 2) + '\n');
  await fs.writeFile(path.join(directory, 'debian-sources.html'), `<!doctype html><meta charset="utf-8"><title>Debian guest sources</title>
<h1>Exact Debian guest source downloads</h1>
<p>The guest uses the Debian source versions below, including statically linked components and the unsigned Linux kernel behind its signed image package.
Each .dsc and its companion archives are hosted by Debian; the archives include upstream sources and Debian build rules.
Links, sizes and checksums come from APT's signed source indexes for the guest package set.
Debian Snapshot links identify the same source version if a file has left the current mirror.</p>
<p><a href="source-packages.txt">Version inventory</a> · <a href="debian-sources.json">Machine-readable download links</a> · <a href="index.html">Local build scripts and other licenses/sources</a></p>
<table><thead><tr><th>Source package</th><th>Version</th><th>Source files</th></tr></thead><tbody>${rows}</tbody></table>
`);
  console.log(`Published source links for ${sources.length} Debian source packages (no source archives downloaded)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('Usage: source-links.mjs ASSET_DIRECTORY');
  await publish(process.argv[2]);
}
