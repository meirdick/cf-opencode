#!/bin/sh
# Trust the egress CA the platform injects at start, then run the image command.
# The CA is ephemeral and only present when outbound HTTPS interception is on.
set -e
ca=/etc/cloudflare/certs/cloudflare-containers-ca.crt
if [ -r "$ca" ]; then
  cp "$ca" /usr/local/share/ca-certificates/cloudflare-containers-ca.crt
  update-ca-certificates >/dev/null 2>&1 || true
fi
# Images before the shell ran the workspace scripts as root. A disk restored from one of
# those has a root-owned home; give it back to `user` once.
if [ "$(stat -c %u /home/user/.cf-opencode 2>/dev/null || echo 1000)" = "0" ]; then
  chown -R 1000:1000 /home/user
fi
exec "$@"
