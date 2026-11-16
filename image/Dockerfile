# cf-opencode workspace image. Built by `cf-opencode init` (wrangler deploy) under the image key "orb".
#
# A snapshot only restores onto the image it was taken from, so every input here is pinned:
# the Debian digest, the tini package version, the OpenCode version, Node and mise. Bump them together
# and treat the result as a new image. Paused workspaces keep restoring onto the old one
# until their next pause.
#
# tini is PID 1. It keeps the container up and reaps `opencode serve`, which the Worker
# starts with setsid so the server outlives the exec that launched it.
#
# OpenCode is the release asset the official installer (https://opencode.ai/v2/install) downloads
# for linux x64: the npm tarball @opencode/cli-linux-x64. It is fetched directly and checked
# against OPENCODE_SHA256, so neither an unpinned script nor a changed asset reaches the image.
# npm's @opencode/cli postinstall selects a native binary and is blocked by npm 12 unless scripts
# are allowed; taking the platform tarball avoids that.
FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc

# Bump both together. The hash is sha256 of
#   https://registry.npmjs.org/@opencode/cli-linux-x64/-/cli-linux-x64-<version>.tgz
# Check it against the registry's own record before you commit a new one:
#   npm view @opencode/cli-linux-x64@<version> dist.integrity   (sha512 of the same file)
ARG OPENCODE_VERSION=2.2.7
ARG OPENCODE_SHA256=d65935464f93f07913633f977cb99723af64eeff6ae7a822722ce89bedabdd45

# libnss-myhostname resolves the container's own hostname. /etc/hosts is read-only and lacks it,
# and sudo warns on every call when the name does not resolve.
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tini=0.19.0-1+b3 \
      ca-certificates \
      curl \
      git \
      bash \
      python3 \
      python3-websocket \
      procps \
      sudo \
      tmux \
      openssh-server \
      gh \
      ripgrep \
      jq \
      unzip \
      xz-utils \
      less \
      libnss-myhostname \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /etc/ssh/ssh_host_*

# Debian's python3-websocket (1.2.3) sends "Origin: http://<host>" also for a wss URL. The Worker refuses a
# websocket with an Origin that is not its own (https), so cf-opencode-browse failed from in here with 403.
# Newer releases of the library send https for wss; this is that one-line change. The grep fails the build
# when a new Debian package no longer has the line.
RUN f=/usr/lib/python3/dist-packages/websocket/_handshake.py \
 && grep -q 'headers.append("Origin: http://%s" % hostport)' "$f" \
 && sed -i 's|headers.append("Origin: http://%s" % hostport)|headers.append("Origin: %s://%s" % ("https" if port == 443 else "http", hostport))|' "$f" \
 && python3 -c 'import websocket._handshake as h; assert "Origin: https://w.example" in h._get_handshake_headers("/", "w.example", 443, {})[0]'

# The hash is checked before tar reads the file; a mismatch fails the build.
# `opencode` on PATH is opencode.sh (copied below), which adds the model config and runs this binary.
# The version check fails the build if the pin and the binary disagree.
RUN curl -fsSL -o /tmp/opencode.tgz \
      "https://registry.npmjs.org/@opencode/cli-linux-x64/-/cli-linux-x64-${OPENCODE_VERSION}.tgz" \
 && echo "${OPENCODE_SHA256}  /tmp/opencode.tgz" | sha256sum -c - \
 && tar -xzf /tmp/opencode.tgz -C /tmp package/bin/opencode \
 && install -D -m 755 /tmp/package/bin/opencode /usr/local/lib/cf-opencode/opencode \
 && rm -rf /tmp/opencode.tgz /tmp/package \
 && /usr/local/lib/cf-opencode/opencode --version | grep -qx "opencode v${OPENCODE_VERSION}"

# Node, because most projects and their tools need it, and a fresh workspace has no time to install it.
# The hash is from https://nodejs.org/dist/v<version>/SHASUMS256.txt. Only bin, lib and include are kept.
ARG NODE_VERSION=22.23.5
ARG NODE_SHA256=c54118104acc524633b5abe106bbf44a53126ec8b4e5fa105cb92b5d7de8a1a1
RUN curl -fsSL -o /tmp/node.tgz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz" \
 && echo "${NODE_SHA256}  /tmp/node.tgz" | sha256sum -c - \
 && tar -xzf /tmp/node.tgz -C /usr/local --strip-components=1 --no-same-owner \
      "node-v${NODE_VERSION}-linux-x64/bin" "node-v${NODE_VERSION}-linux-x64/lib" "node-v${NODE_VERSION}-linux-x64/include" \
 && rm -f /tmp/node.tgz \
 && node --version | grep -qx "v${NODE_VERSION}" \
 && npm --version >/dev/null

# mise, for a project that pins another version of Node or another tool (mise.toml, .tool-versions,
# .nvmrc, .node-version). It installs nothing by itself: the agent or the user runs `mise install`.
# The hash is from the release's SHASUMS256.txt. Its shims come first on PATH, so a pinned version wins.
ARG MISE_VERSION=2026.11.2
ARG MISE_SHA256=62cad463c1413f05398ca339168a8f655120b6f0b0b8adce3bc6758bafaf0602
RUN curl -fsSL -o /tmp/mise \
      "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-x64" \
 && echo "${MISE_SHA256}  /tmp/mise" | sha256sum -c - \
 && install -m 755 /tmp/mise /usr/local/bin/mise \
 && rm -f /tmp/mise \
 && mkdir -p /etc/mise \
 && printf '%s\n' '[settings]' 'idiomatic_version_file_enable_tools = ["node"]' > /etc/mise/config.toml \
 && mise --version | grep -q "^${MISE_VERSION} "
ENV PATH=/home/user/.local/share/mise/shims:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# `user` runs everything in the workspace: opencode serve, the shell, the SSH login.
# Password "*" is no password, but not a locked account, so sshd accepts its keys.
# Passwordless sudo, so the agent and the shell can apt-get install.
RUN useradd --create-home --shell /bin/bash --uid 1000 user \
 && usermod -p '*' user \
 && echo 'user ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/user \
 && chmod 440 /etc/sudoers.d/user \
 && mkdir -p /home/user/project \
 && chown -R user:user /home/user

# sshd never listens. The Worker runs `sshd -i` per connection, behind the workspace
# password, and bridges its stdin/stdout to a websocket. Host keys are made on first use,
# so no two workspaces share one; they live on the disk and survive a pause.
COPY sshd.conf /etc/ssh/sshd_config.d/cf-opencode.conf

# gh reads GH_TOKEN. It holds a placeholder: the Worker puts the real token on requests to
# api.github.com, so no token is on this disk. opencode serve gets it from the Worker; this
# gives it to login shells and to tmux panes, with the mise shims on PATH. sshd.conf does the same for
# `ssh host command`.
RUN printf '%s\n' 'export GH_TOKEN="${GH_TOKEN:-cf-opencode-egress}"' \
      'case ":$PATH:" in *:/home/user/.local/share/mise/shims:*) ;; *) PATH="/home/user/.local/share/mise/shims:$PATH"; export PATH ;; esac' \
      > /etc/profile.d/cf-opencode.sh \
 && printf '%s\n' '. /etc/profile.d/cf-opencode.sh' >> /etc/bash.bashrc

# The platform injects an egress CA at /etc/cloudflare/certs when outbound HTTPS is
# intercepted. It does not exist at build time. Trust it before tini, as root; the
# `user` account cannot write the system trust store. A boot with no interception
# has no CA file, and the copy is skipped.
COPY entrypoint.sh /usr/local/bin/cf-opencode-entrypoint
COPY browse.sh /usr/local/bin/cf-opencode-browse
COPY search.sh /usr/local/bin/cf-opencode-search
COPY fetch.sh /usr/local/bin/cf-opencode-fetch
COPY preview.sh /usr/local/bin/cf-opencode-preview
COPY notify.sh /usr/local/bin/cf-opencode-notify
COPY store.sh /usr/local/bin/cf-opencode-store
COPY opencode.sh /usr/local/bin/opencode
RUN chmod 755 /usr/local/bin/cf-opencode-entrypoint /usr/local/bin/cf-opencode-browse \
      /usr/local/bin/cf-opencode-search /usr/local/bin/cf-opencode-fetch /usr/local/bin/cf-opencode-preview \
      /usr/local/bin/cf-opencode-notify /usr/local/bin/cf-opencode-store /usr/local/bin/opencode

# Stay root. The entrypoint trusts the egress CA, which only root can install, and the
# Worker starts opencode serve with `user: 1000:1000`. A root entrypoint is what the
# platform's own egress example uses.
WORKDIR /home/user
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/usr/local/bin/cf-opencode-entrypoint"]
CMD ["sleep", "infinity"]
