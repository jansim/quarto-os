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
COPY boot-init /boot-init
COPY slim-guest.sh /slim-guest.sh
COPY pack-guest.sh /pack-guest.sh
COPY tools/ /tools/
ARG GUEST_PROFILE=slim
RUN apt-get update -o APT::Update::Error-Mode=any && \
    apt-get install -y --no-install-recommends python3 python3-zstandard && \
    sh /pack-guest.sh

FROM guest AS assets
COPY --from=sources /guest-sources.tar.gz /guest-sources.tar.gz
COPY --from=sources /source-packages.txt /source-packages.txt
