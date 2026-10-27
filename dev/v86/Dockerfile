FROM --platform=linux/amd64 debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8 AS packages
ENV DEBIAN_FRONTEND=noninteractive
RUN dpkg --add-architecture i386 && apt-get update && apt-get install -y --no-install-recommends kmod cpio
RUN touch /tmp/empty-status && apt-get -o APT::Architecture=i386 -o Dir::State::status=/tmp/empty-status install -y --download-only --no-install-recommends linux-image-686 busybox-static bash git python3 ca-certificates base-files
RUN mkdir /guest && for p in /var/cache/apt/archives/*_i386.deb /var/cache/apt/archives/*_all.deb; do test ! -f "$p" || dpkg-deb -x "$p" /guest; done
RUN for d in /guest/lib/modules/*; do depmod -b /guest "$(basename "$d")"; done

# The signed package set is common to both profiles. Cache its corresponding
# sources independently from init/trim changes so local iteration stays quick.
FROM packages AS sources
COPY collect-sources.sh /collect-sources.sh
RUN sh /collect-sources.sh && cp /sources/packages.txt /source-packages.txt

FROM packages AS guest
COPY init /guest/init
RUN chmod +x /guest/init && cp /guest/boot/vmlinuz-* /bzimage && \
    ver=$(basename /guest/lib/modules/*) && \
    for mod in virtio_pci 9p 9pnet_virtio; do modprobe -d /guest -S "$ver" --show-depends "$mod"; done | awk '$1 == "insmod" { print $2 }' | sort -u > /keep-modules
RUN find /guest/lib/modules -type f -name '*.ko*' | while read -r file; do grep -qxF "$file" /keep-modules || rm "$file"; done
COPY slim-guest.sh /slim-guest.sh
ARG GUEST_PROFILE=slim
RUN case "$GUEST_PROFILE" in slim) sh /slim-guest.sh ;; full) ;; *) echo "Unknown GUEST_PROFILE: $GUEST_PROFILE" >&2; exit 1 ;; esac
RUN rm -rf /guest/boot /guest/usr/share/man /guest/usr/share/locale /guest/usr/lib/python3.11/test && \
    for d in /guest/lib/modules/*; do depmod -b /guest "$(basename "$d")"; done && \
    cd /guest && find . -print0 | cpio --null -o --format=newc > /guest.cpio && gzip /guest.cpio
RUN if [ "$GUEST_PROFILE" = slim ] && [ "$(stat -c %s /guest.cpio.gz)" -gt 52428800 ]; then \
      echo 'Slim guest exceeds its 50 MiB compressed size budget' >&2; exit 1; fi

FROM guest AS assets
COPY --from=sources /guest-sources.tar.gz /guest-sources.tar.gz
COPY --from=sources /source-packages.txt /source-packages.txt
