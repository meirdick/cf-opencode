# Workspace image

Debian bookworm-slim plus `tini`, `git`, `curl`, `tmux`, `openssh-server`,
`sudo`, and OpenCode. The Worker starts `opencode serve` as `user` after the
container is up, and runs `tmux` (shell) or `sshd -i` (SSH) per connection; the
image itself only sleeps. sshd never listens on a port.

Pin the Debian digest and `OPENCODE_VERSION` together. A snapshot restores only
onto the image it was taken from, so an unpinned rebuild strands paused workspaces.
