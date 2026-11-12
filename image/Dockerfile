# cf-opencode workspace image. Built by `cf-opencode init` (wrangler deploy) under the image key "orb".
#
# A snapshot only restores onto the image it was taken from, so every input here is pinned:
# the Debian digest, the tini package version, and the OpenCode version. Bump them together
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
      less \
      libnss-myhostname \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /etc/ssh/ssh_host_*

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
# gives it to login shells and to tmux panes. sshd.conf does the same for `ssh host command`.
RUN printf '%s\n' 'export GH_TOKEN="${GH_TOKEN:-cf-opencode-egress}"' > /etc/profile.d/cf-opencode.sh \
 && printf '%s\n' '. /etc/profile.d/cf-opencode.sh' >> /etc/bash.bashrc

# The platform injects an egress CA at /etc/cloudflare/certs when outbound HTTPS is
# intercepted. It does not exist at build time. Trust it before tini, as root; the
# `user` account cannot write the system trust store. A boot with no interception
# has no CA file, and the copy is skipped.
COPY entrypoint.sh /usr/local/bin/cf-opencode-entrypoint
COPY browse.sh /usr/local/bin/cf-opencode-browse
COPY search.sh /usr/local/bin/cf-opencode-search
COPY fetch.sh /usr/local/bin/cf-opencode-fetch
COPY opencode.sh /usr/local/bin/opencode
RUN chmod 755 /usr/local/bin/cf-opencode-entrypoint /usr/local/bin/cf-opencode-browse \
      /usr/local/bin/cf-opencode-search /usr/local/bin/cf-opencode-fetch /usr/local/bin/opencode

# Stay root. The entrypoint trusts the egress CA, which only root can install, and the
# Worker starts opencode serve with `user: 1000:1000`. A root entrypoint is what the
# platform's own egress example uses.
WORKDIR /home/user
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/usr/local/bin/cf-opencode-entrypoint"]
CMD ["sleep", "infinity"]
