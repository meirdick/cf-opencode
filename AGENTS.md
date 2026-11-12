# Installing cf-opencode as an agent

You are installing cf-opencode into the user's Cloudflare account. Everything runs in their account;
there is no hosted service. Do not print or pass any token as a command argument.

1. Check the machine: Node 22+, `docker info`, and `docker buildx version` must all succeed.
2. Credentials: the user either ran `npx wrangler login` on this machine, or gave you a Cloudflare API
   token with Workers Scripts Write and Workers Containers Write in `CLOUDFLARE_API_TOKEN` (or a mode-600
   file for `--token-file`). Ask for one of those if neither exists. Never ask for the token in chat.
3. Install the CLI: `npm install -g cf-opencode`. If npm cannot write to its global folder, use
   `npx cf-opencode` in place of `cf-opencode` in every step.
4. Run `cf-opencode init --yes --json` (add `--account <id>` when the login sees several accounts).
   Progress is on stderr; stdout is one JSON document with `url` on success. A failure is one or more
   `Failed: <cause> — fix: <action>` lines: do the fix, then rerun the same command. Reruns are safe and
   keep the control token.
5. If init reports an existing Worker this machine did not deploy, ask the user before passing `--adopt`;
   it replaces that Worker's control token. `--name <other>` makes a separate install instead.
   Init also gives workspaces the machine's `gh` login, so private repositories and push work. Pass
   `--no-github` if the user did not agree to that; `cf-opencode git-token` sets it later.
6. Verify with `cf-opencode doctor` (exit 0, every line ✓ or !).
7. Tell the user the Worker URL and the next step: `cf-opencode connect` from a git checkout.

Models and browsing use the account's AI and Browser Run bindings; no model key or browser token is needed.
