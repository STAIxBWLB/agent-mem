# OpenCode contract

Investigation and setup contract for #176 (OpenCode target), recorded 2026-10-31. The installed client is `opencode --version` `1.18.35` (`~/.local/bin/opencode`). Source references are pinned to the matching tag [`anomalyco/opencode@v1.18.35`](https://github.com/anomalyco/opencode/tree/v1.18.35) (commit `53d1eabb61e21162157817bf677da0a4ad3332e3`), read through the GitHub API. Only `--help`/`--version`, the local config file's key names and the local session database's schema and JSON key names were read. No session content, credential or instruction file was opened, and no native command changed configuration.

## MCP configuration

- Format: JSON or JSONC, a top-level `mcp` object keyed by server name. A local server is `{ "type": "local", "command": [argv...], "environment"?, "cwd"?, "enabled"?, "timeout"? }` ([MCP servers](https://opencode.ai/docs/mcp-servers/)).
- Global file: `<xdgConfig>/opencode/` where `xdgConfig` comes from `xdg-basedir` 5.1.0: `XDG_CONFIG_HOME` used verbatim when set and non-empty (no trimming), else `~/.config` ([`packages/core/src/global.ts` L13](https://github.com/anomalyco/opencode/blob/v1.18.35/packages/core/src/global.ts#L13)). The loader merges `config.json`, then `opencode.json`, then `opencode.jsonc` from that directory ([`config.ts` loadGlobal L260-L274](https://github.com/anomalyco/opencode/blob/v1.18.35/packages/opencode/src/config/config.ts#L260-L274)), so a later file can override an earlier one's `mcp.amem`.
- Project scope: `opencode.json` / `opencode.jsonc` found walking up from the working directory to the worktree, and `.opencode/` directories. Project config overrides global ([Config precedence](https://opencode.ai/docs/config/)). `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR` and `OPENCODE_CONFIG_CONTENT` route configuration elsewhere.
- Working directory: a local server without `cwd` starts in the session's instance directory ([`mcp/index.ts` L345-L346](https://github.com/anomalyco/opencode/blob/v1.18.35/packages/opencode/src/mcp/index.ts#L345-L346)). amem's MCP server binds its project from that cwd, so a global entry follows the project of each session.
- Native command: `opencode mcp` has `add`, `list`, `auth`, `logout` and `debug`, and no `remove`. `opencode mcp add <name> -- <cmd...>` is non-interactive and writes the global file through `jsonc-parser` edits ([`cli/cmd/mcp.ts` L412-L427, L455-L501](https://github.com/anomalyco/opencode/blob/v1.18.35/packages/opencode/src/cli/cmd/mcp.ts#L412-L501)). Without a name it prompts.

## Setup decision

`amem setup opencode` edits the global `opencode.json` directly, like Jcode and Antigravity, using the shared strict-JSON lexical codec (`src/setup-json.ts`). The native `add` would give the same entry but has no matching `remove`, so undo would still need a direct edit; one direct path keeps apply and undo symmetric. Contract:

- It owns only `mcp.amem` = `{ "type": "local", "command": [<bun>, "--smol", <entry>, "mcp"], "enabled": true }`, with no `cwd`. Unrelated bytes, other servers and keys are preserved exactly, and the file mode is kept.
- Preview by default; `--apply`/`--undo` with a private receipt in `<memory-home>/setup/opencode.json`; idempotent re-apply; undo restores the original bytes when the file is untouched, otherwise removes only the managed entry and refuses if that entry was edited.
- `XDG_CONFIG_HOME` is used exactly as OpenCode reads it: an absolute value keeps its literal spelling, including surrounding spaces; unset or empty uses `~/.config`; a relative value is refused because OpenCode would resolve it against its own working directory.
- Refused, before any write: JSONC or other non-strict JSON (`opencode.json` that does not parse as one JSON object); a sibling `opencode.jsonc` or `config.json` (merged around this file); `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR` or `OPENCODE_CONFIG_CONTENT` set in apply/preview; symlinked config paths; a Bun or entry path containing `{env:` or `{file:` (OpenCode substitutes those in config strings).
- A project `opencode.json` that defines `mcp.amem` overrides the global entry; setup does not inspect or edit project files.
- No instruction file (`AGENTS.md`, `opencode.json` `instructions`) and no plugin directory is touched.
- `setup all` includes OpenCode; when the `opencode` CLI is not on `PATH` it is reported and skipped like the other clients.
- The verified layout version is 1.18.35; `setup` reports a different installed version as advisory.

## Hooks and plugins

OpenCode has no settings-file command hooks. Lifecycle integration is a JavaScript/TypeScript plugin loaded from `~/.config/opencode/plugins/`, `.opencode/plugins/` or npm packages listed in `plugin`; plugins subscribe to events such as `session.created`, `session.idle`, `session.compacted`, `session.deleted`, `message.updated` and `tool.execute.after` ([Plugins](https://opencode.ai/docs/plugins/)). There is no session-end event; `session.idle` fires after each turn. A plugin runs inside the OpenCode process with its full permissions.

Setup installs no plugin: a capture plugin would run in-process code on every session, and it would only be useful together with an ingest reader, which is not eligible (below).

## Transcripts: not ingested

OpenCode 1.18.35 stores sessions in SQLite at `<xdgData>/opencode/opencode.db` (tables `project`, `session`, `message`, `part`, among others). Each `message.data` is JSON with `role`, `time`, `agent`, `model`, `parentID` and, on assistant messages, `path: { cwd, root }`; user messages carry no path. In the local database all 101 assistant messages had `path.cwd` equal to their session's `directory`.

`amem ingest opencode` is not provided:

- **No per-message origin for user messages.** Only assistant messages record `path.cwd`; a user prompt inherits it from the session. Native ingest elsewhere in amem requires an origin on every captured message.
- **No stable cursor.** Rows are mutable: `/undo` and revert delete messages and parts ([`session/revert.ts` L108-L120](https://github.com/anomalyco/opencode/blob/v1.18.35/packages/opencode/src/session/revert.ts#L108-L120)), parts are rewritten in place while streaming (`Session.updatePart` / `updatePartDelta`, [`session/session.ts` L459-L460](https://github.com/anomalyco/opencode/blob/v1.18.35/packages/opencode/src/session/session.ts#L459-L460)). An append-only byte or row-id cursor would replay or miss content.
- **Live database.** The file is a WAL-mode database owned by a running process; amem's other native readers consume append-only JSONL. A read-only SQLite reader with snapshot isolation and a schema-version contract (`migration` table, 38 rows locally) would be needed first.

Upgrade path: an export-based reader (`opencode export <sessionID>` emits session JSON) bound to a finished session and keyed by message id, once OpenCode records an origin on every message or amem accepts session-level origin for a whole session.
