#!/bin/sh
# `opencode` on PATH. Gives every OpenCode in the workspace the Cloudflare model config that
# `opencode serve` gets from the Worker: a shell, an SSH command, a tmux or herdr pane.
# The Worker writes the config on each wake. It holds a placeholder, not a key.
f=/home/user/.cf-opencode/opencode-config.json
if [ -z "${OPENCODE_CONFIG_CONTENT:-}" ] && [ -r "$f" ]; then
  OPENCODE_CONFIG_CONTENT=$(cat "$f")
  export OPENCODE_CONFIG_CONTENT
fi
exec /usr/local/lib/cf-opencode/opencode "$@"
