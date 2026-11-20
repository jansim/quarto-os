FROM --platform=linux/amd64 debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2 AS packages
ENV DEBIAN_FRONTEND=noninteractive
# Debian 13 (trixie) still builds i386 userland packages, but no longer ships an
# i386 kernel. Take only the 686 kernel from Debian 12 (bookworm, incl. security
# updates); every other guest package comes from trixie.
COPY bookworm-kernel.sources /etc/apt/sources.list.d/bookworm-kernel.sources
COPY bookworm-kernel.pref /etc/apt/preferences.d/bookworm-kernel.pref
RUN dpkg --add-architecture i386 && apt-get update -o APT::Update::Error-Mode=any && apt-get install -y --no-install-recommends kmod cpio
RUN touch /tmp/empty-status && apt-get -o APT::Architecture=i386 -o Dir::State::status=/tmp/empty-status install -y --download-only --no-install-recommends linux-image-686 busybox-static bash git python3 ca-certificates base-files
# Trixie packages install below /usr only (merged /usr); the bookworm kernel and
# older packages may still use /bin, /lib or /sbin. Create the merged-/usr links
# first and keep them while extracting, so all files land under /usr.
RUN mkdir -p /guest/usr/bin /guest/usr/sbin /guest/usr/lib && \
    ln -s usr/bin /guest/bin && ln -s usr/sbin /guest/sbin && ln -s usr/lib /guest/lib && \
    for p in /var/cache/apt/archives/*_i386.deb /var/cache/apt/archives/*_all.deb; do \
      test ! -f "$p" || dpkg-deb --fsys-tarfile "$p" | tar -x -C /guest --keep-directory-symlink --no-same-owner || exit 1; \
    done && \
    for d in bin sbin lib; do test -L "/guest/$d" || { echo "/guest/$d is not a merged-/usr link" >&2; exit 1; }; done
RUN for d in /guest/lib/modules/*; do depmod -b /guest "$(basename "$d")"; done

# Generate source download links from the signed package set, including static
# dependencies. Cache the small inventory separately from guest packing.
FROM packages AS sources
COPY collect-sources.sh /collect-sources.sh
RUN sh /collect-sources.sh

FROM packages AS guest
COPY init /guest/init
COPY boot-init /boot-init
COPY slim-guest.sh /slim-guest.sh
COPY pack-guest.sh /pack-guest.sh
COPY tools/ /tools/
ARG GUEST_PROFILE=slim
RUN apt-get update -o APT::Update::Error-Mode=any && \
    apt-get install -y --no-install-recommends python3 python3-zstandard && \
    sh /pack-guest.sh

FROM guest AS assets
COPY --from=sources /sources/packages.txt /source-packages.txt
COPY --from=sources /sources/uris.txt /source-uris.txt
