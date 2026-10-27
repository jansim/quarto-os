#!/bin/sh
set -eu
profile=${GUEST_PROFILE:-slim}
chmod +x /guest/init
cp /guest/boot/vmlinuz-* /bzimage
version=$(basename /guest/lib/modules/*)
for module in virtio_pci 9p 9pnet_virtio; do
  modprobe -d /guest -S "$version" --show-depends "$module"
done | awk '$1 == "insmod" { print $2 }' | sort -u > /keep-modules
find /guest/lib/modules -type f -name '*.ko*' | while read -r file; do
  grep -qxF "$file" /keep-modules || rm "$file"
done
case "$profile" in slim) sh /slim-guest.sh ;; full) ;; *) echo "Unknown GUEST_PROFILE: $profile" >&2; exit 1 ;; esac
rm -rf /guest/boot /guest/usr/share/man /guest/usr/share/locale /guest/usr/lib/python3.11/test
for directory in /guest/lib/modules/*; do depmod -b /guest "$(basename "$directory")"; done
mkdir -p /guest/data /guest/mnt /rootfs
chmod 777 /guest/data
ln -s /data /guest/mnt/host
python3 /tools/fs2json.py --zstd --out /fs.json /guest
python3 /tools/copy-to-sha256.py --zstd /guest /rootfs

mkdir -p /bootstrap/bin /bootstrap/dev /bootstrap/lib/modules
cp /guest/bin/busybox /bootstrap/bin/busybox
cp -a /guest/lib/modules/. /bootstrap/lib/modules/
cp /boot-init /bootstrap/init
chmod +x /bootstrap/init
(cd /bootstrap && find . -print0 | cpio --null -o --format=newc > /bootstrap.cpio)
gzip -c /bootstrap.cpio > /guest.cpio.gz
if [ "$profile" = slim ]; then
  size=$(du -sb /rootfs | cut -f1)
  size=$((size + $(stat -c %s /guest.cpio.gz)))
  if [ "$size" -gt 52428800 ]; then
    echo 'Slim guest exceeds its 50 MiB compressed backing-file size budget' >&2
    exit 1
  fi
fi
