# @cf-opencode/plugin

> Experimental, and not published. The `cf-opencode` CLI is the supported way to use a workspace.
> This plugin is kept for work on handing tasks from a local OpenCode session to a workspace.

OpenCode plugin for [cf-opencode](https://github.com/meirdick/cf-opencode):
OpenCode workspaces on Cloudflare Containers, in your own account.

Deploy the Worker first with the `cf-opencode` CLI (`cf-opencode init`). The
plugin talks only to that Worker.

## Install

```json
{ "plugin": ["@cf-opencode/plugin"] }
```

Set these in the environment that starts OpenCode:

| Variable | Value |
| --- | --- |
| `CF_OPENCODE_URL` | The Worker URL that `cf-opencode init` printed |
| `CF_OPENCODE_CONTROL_TOKEN` | The contents of `~/.cf-opencode/control-token` |

The control token is read from the environment. Do not put it in the OpenCode
config.

## OpenCode 1

Run OpenCode with `OPENCODE_EXPERIMENTAL_WORKSPACES=true`. The plugin registers
a `cf-opencode` workspace type on the experimental workspace API, so `/warp`
moves a session into a workspace.

## OpenCode 2

OpenCode 2 removed the workspace API. The plugin registers `/cf-connect`, which
wakes the workspace for the current project and prints the attach command:

```
cf-opencode connect <workspace>
```

The CLI does the attach. A plugin cannot replace the running client.

## Options

```json
{ "plugin": [["@cf-opencode/plugin", { "url": "https://cf-opencode.example.workers.dev", "directory": "/home/user/project" }]] }
```

- `url`: the Worker URL. Default: `CF_OPENCODE_URL`.
- `directory`: the project path inside the workspace. Default: `/home/user/project`.

## License

Apache-2.0.
