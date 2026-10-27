#!/bin/sh
# Record exact source versions and download URLs without downloading archives.
# Include static components and the unsigned kernel behind the signed package.
set -eu
mkdir -p /sources
for package in /var/cache/apt/archives/*_i386.deb /var/cache/apt/archives/*_all.deb; do
  [ -f "$package" ] || continue
  source=$(dpkg-deb -f "$package" Source)
  if [ -z "$source" ]; then
    printf '%s=%s\n' "$(dpkg-deb -f "$package" Package)" "$(dpkg-deb -f "$package" Version)"
  else
    version=$(printf '%s' "$source" | sed -n 's/.*(\(.*\))/\1/p')
    name=${source%% *}
    printf '%s=%s\n' "$name" "${version:-$(dpkg-deb -f "$package" Version)}"
  fi
  for field in Built-Using Static-Built-Using; do
    dpkg-deb -f "$package" "$field" | tr ',' '\n' | sed -n 's/^ *\([^ ]*\) *(= \([^)]*\)).*/\1=\2/p'
  done
done | sort -u > /sources/packages.txt
sed -i 's/^Types: deb$/Types: deb deb-src/' /etc/apt/sources.list.d/debian.sources
apt-get update -o APT::Update::Error-Mode=any
cd /sources
while read -r source; do
  printf '# %s\n' "$source"
  # --print-uris lists the .dsc and all source archives with sizes/checksums.
  # It does not fetch those files; only the signed APT indexes are downloaded.
  apt-get source --print-uris --download-only --only-source "$source" > /tmp/apt-source-uris.txt
  sed -n "/^'/p" /tmp/apt-source-uris.txt
done < packages.txt > uris.txt
