#!/bin/sh
# Run in the builder: retain exact source versions, including statically linked
# components and Debian's unsigned kernel source behind the signed image package.
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
while read -r source; do apt-get source --download-only --only-source "$source"; done < packages.txt
# Source packages contain Debian build rules, upstream sources and license texts.
tar -czf /guest-sources.tar.gz -C / sources
