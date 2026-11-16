# RFC: Claude subscription harness for remote sessions

**Status:** proposal · **Owner:** mdick85 · **From:** sciencecake dogfood (see `docs/cf-opencode-dogfood-report.md` in meirdick/sciencecake) · **Date:** 2026-11-16

## Problem

Remote sessions today run on opencode with API-key/model providers. Claude — the model many owners most want for design/review work — is wired two ways today, both broken in practice:

1. **Gateway/API-key route:** listing Anthropic models without credentials behind them fails at runtime (`7003: User Input Error` — observed on sciencecake). Owners with Claude **subscriptions** (Pro/Max/Ultra) reasonably expect to use them, not open API billing.
2. **No harness route:** Anthropic officially supports headless subscription auth — `claude setup-token` mints a **one-year OAuth token** that "authenticates with your Claude subscription," designed exactly for "environments where interactive browser login isn't available" (CI, servers — i.e., our workspaces). Amp does this for its orbs. cf-opencode has no first-class way to do the same.

The gap, in one line: **there is no `cf-opencode run` that executes on Claude using the owner's Claude subscription, fully tracked by the task lifecycle.**

## Non-goals

- Not making opencode itself speak the Claude Code OAuth token (it's scoped to Claude Code clients; the Anthropic opencode provider is API-key-only as of today). If Anthropic ships subscription OAuth for the Messages API later, `--model` alone suffices and this RFC shrinks.
- Not covering non-Anthropic harnesses. The design should keep a harness abstraction (opencode today, claude next) but only claude ships first.

## Proposed UX

```sh
# One time, on the owner's machine:
cf-opencode claude login      # wraps `claude setup-token`: browser flow, captures the token,
                              # uploads it to the Worker as an encrypted secret
cf-opencode claude status     # token expiry (claims), last use, active workspaces

# Then Claude tasks are first-class remote tasks:
cf-opencode run --harness claude "<task>" [workspace] --title "..." 
cf-opencode tasks <session> --follow        # live tail of the Claude Code run
cf-opencode tasks <session> --reply "..."   # continues the Claude Code session (headless --resume)
cf-opencode claude logout      # removes the token; prints how to revoke at claude.ai
```

`run` without `--harness` keeps today's behavior. A `--model anthropic/...` value with no anthropic credential configured can hint the user toward `claude login` rather than failing with a raw provider error (today's 7003 experience).

## How it works

### 1. Token storage (Worker)

- `claude login` runs `claude setup-token` locally, captures the printed token, and stores it Worker-side (same trust domain as the control token / github token: single-owner install, Worker secrets storage). It never lands in a repo or a workspace image.
- Claims are parsed for expiry; `claude status` and doctor surface `<30 days` warnings.
- Revocation is the user's claude.ai action; `claude logout` deletes the stored copy and prints the revoke path.

### 2. Harness execution (workspace)

- Task record gains `harness: "opencode" | "claude"` (default opencode). The Worker's task-start path (`worker/src/tasks-api.ts` POST handler) branches on it.
- Claude-harness spawn: inject `CLAUDE_CODE_OAUTH_TOKEN` into the workspace (secret file pattern: `~/.secrets/`, exported in the run env), ensure Claude Code is installed (bake into the image; install-on-demand fallback), then run headless:
  `claude -p "<task>" --output-format stream-json` inside the workspace's tmux.
- **Guardrail (the one that silently costs money):** the workspace env for claude-harness tasks must NOT contain `ANTHROPIC_API_KEY` — Claude Code's credential precedence puts the API key above the OAuth token and **bills the API** instead of the subscription. Enforce an env allowlist for these workspaces and check at spawn; fail loudly rather than silently misbilling.
- Stream-json events map onto the existing task lifecycle: `running` while streaming, `done`/`failed` from the final result; summary from the last assistant message; `--follow` tails events; `--reply` maps to `claude -p --resume <session-id> "<reply>"`. Branch/PR conventions stay the same (the brief still demands push + PR; parse the result message for the PR URL as opencode tasks do).

### 3. Honest limits to document

- The token is **model-requests-only**: no claude.ai connectors, no Remote Control. Fine for agent tasks.
- Subscription **plan usage limits apply** (weekly windows on Pro/Max). Multiple concurrent workspaces share one plan's limits — surface 429/limit events in `tasks --follow` output, and offer `claude_max_concurrent` (default 1-2) as a Worker config.
- One token per install (single-owner product); multi-owner team token scoping is out of scope here.

## Implementation sketch (matching current code)

- `cli/src/commands` (+ `index.ts` registry): `claude login|status|logout` — local `claude setup-token` wrapper (`cli` spawns the binary or prints instructions if absent), ControlClient gains token upload/delete.
- `worker/src/tasks-api.ts`: accept `harness` in POST; branch spawn; new `worker/src/claude-harness.ts` (env injection, install check, tmux launch, stream-json reader producing the same task-state machine the opencode sessions use).
- `worker/src/a2a.ts` metadata: pass `harness` through A2A messages the same way `model` passes today.
- `image/`: preinstall Claude Code (official installer) so claude tasks don't pay an install tax per spawn.
- `cli/src/task-commands.ts`: `--harness` flag; `--reply`/`--follow` adapters detect harness from the task record.
- Tests: token round-trip, env allowlist enforcement (spawn fails closed if ANTHROPIC_API_KEY present), stream-json→state mapping, resume flow.

## Phases

- **P0 (stopgap, zero code):** document the manual recipe — ssh-deposit the setup-token, install Claude Code, run in tmux — plus the precedence warning. Unblocks dogfood now.
- **P1 (MVP):** `claude login/logout/status` + `run --harness claude` with basic running→done/failed states, follow tail, env guardrail, image preinstall.
- **P2:** `--reply` resume parity, PR/commit parsing parity with opencode tasks, plan-limit event surfacing, concurrency cap, `claude status` usage stats (from stream-json token counts), `doctor` integration.
- **P3 (if Anthropic ships subscription OAuth for the Messages API):** collapse the harness into `--model anthropic/...` and keep only the token management.

## Open questions

1. Token storage encryption at rest in the Worker — match whatever the github-token path does today, or stronger?
2. Should `claude login` also offer the **API-credits** route (Max/Ultra subscriber credits → Console API key) as `claude login --api-credits`, so owners choose subscription-harness vs credits-per-API? The credits route feeds opencode's existing anthropic provider directly (no harness needed).
3. tmux vs a supervised process: keep everything inside the workspace's tmux (current `shell` pattern) for P1?
