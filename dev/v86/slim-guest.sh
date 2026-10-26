#!/bin/sh
# Run in the image builder. Keep Bash, Python, core Git, shared libraries,
# terminfo, locale support and /usr/share/doc copyright notices intact.
set -eu
guest=/guest

# The kernel is already built and init mounts devtmpfs and loads the required
# drivers directly. No udev daemon, hardware database or initramfs generator runs.
rm -rf "$guest/lib/udev" "$guest/usr/share/initramfs-tools" "$guest/usr/lib/klibc"

# Core Git commands are native executables. Perl is used by optional Git tools
# such as filter-branch, not the documented offline workflows.
rm -rf "$guest/usr/share/perl" "$guest/usr/share/perl5" \
  "$guest/usr/lib/i386-linux-gnu/perl" "$guest/usr/lib/i386-linux-gnu/perl-base"
rm -f "$guest/usr/bin/perl" "$guest/usr/bin/"perl5* \
  "$guest/usr/lib/i386-linux-gnu/"libperl*

# There is no network or mail service inside the guest. These helpers and Scalar
# are unnecessary for local init/status/add/commit/diff/log/branch/clone operations.
rm -rf "$guest/usr/share/gitweb"
rm -f "$guest/usr/bin/scalar"
for tool in git-remote-http git-remote-https git-http-push git-imap-send \
  git-http-fetch git-daemon git-http-backend scalar; do
  rm -f "$guest/usr/lib/git-core/$tool"
done
