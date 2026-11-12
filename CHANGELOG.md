# Changelog

## Unreleased

- `cf-opencode-search` in the workspace: web search through the account's AI binding and AI Gateway, with no
  key. Setting `searchProvider` (default `exa`).
- `cf-opencode-fetch` in the workspace: a page as Markdown, links, HTML, a screenshot or a PDF, through the
  Browser Run binding.
- The image has the Python `websocket` module, for the browser session's Chrome DevTools Protocol.

### Security

- The Worker checks the workspace password itself before it calls a workspace's Durable Object. A request
  to `/oc`, `/browse`, `/shell` or `/ssh` with no password or a wrong one is a 401 that costs one Worker
  request; before, it created a Durable Object for any id it named. Passwords are derived from the control
  token, so the check needs no state. The control API refuses a spawn with any other password.
- Every refused password gets the same 401 body, from the Worker and from the Durable Object. It names no
  workspace, and a deleted workspace answers 410 only to the holder of its password.
- `/shell`, `/ssh` and `/browse` refuse a request whose `Origin` is another site, so a web page cannot use
  Basic credentials a browser cached for the Worker. Clients that send no `Origin` (the CLI, ssh, curl) and
  the Worker's own origin still work.
- The browser relay `/browse/<workspace>/<session>` serves only sessions that workspace opened. Before, any
  workspace's password reached any browser session on the account.

- Two `connect`s in flight with different inputs no longer share one op. The op journal hashed a field the
  API never sends, so the second caller could attach to the first one's spawn and get its password.

## 0.1.0 (2026-11-12)

First release. One package, `cf-opencode`: the CLI. It carries the Worker source and the workspace image,
and deploys them to your Cloudflare account with `cf-opencode init`.

What works:

- Workspaces on Cloudflare Containers that pause to a snapshot when idle and restore on connect.
- Models through the account's AI binding and AI Gateway. Browsing through the Browser Run binding. No keys.
- `shell`, `ssh` and `ssh-config` over the Worker. No open port.
- GitHub access with a token that stays in the Worker. `init` sets it up once from the machine's `gh` login.
- `connect --continue` and `--session` open a session in the workspace. `sessions` lists them across workspaces.
- `rebuild` moves a workspace to the deployed image. Snapshots refresh before they expire.

Known limits are in the README, section Limits.
