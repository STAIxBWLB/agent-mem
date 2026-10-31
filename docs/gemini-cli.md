# Gemini CLI contract

Investigation and setup contract for #176 (Gemini CLI target), recorded 2026-10-31. Started from codex's discovery checkpoint (`00a68ab`, recorded against 0.53.1); the installed client has since moved, so everything below is re-pinned to the installed `gemini --version` **0.61.0** and to source tag [`google-gemini/gemini-cli@v0.61.0`](https://github.com/google-gemini/gemini-cli/tree/v0.61.0) (commit `bb523741c7429a44d03e964bc124c7c92df59d5f`), read through the GitHub API. Only `--help`/`--version`, the local settings file's key names and one local transcript's record key names were read. The native `mcp add`/`remove` commands were run only in a scratch `HOME`/`GEMINI_CLI_HOME`. No session content, credential or instruction file (`GEMINI.md`) was opened or changed.

## Configuration boundary

- User settings: `<home>/.gemini/settings.json`, where `<home>` is `GEMINI_CLI_HOME` when set, else the OS home directory ([`packages/core/src/utils/paths.ts` homedir](https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/core/src/utils/paths.ts), [`packages/core/src/config/storage.ts` getGlobalSettingsPath](https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/core/src/config/storage.ts)). Workspace settings: `<project>/.gemini/settings.json`. System settings and defaults files can be redirected with `GEMINI_CLI_SYSTEM_SETTINGS_PATH` and `GEMINI_CLI_SYSTEM_DEFAULTS_PATH`.
- MCP servers live under `mcpServers.<name>` with `command` and `args` for stdio servers.
- Settings are read through `strip-json-comments`, and the native writer preserves comments (`updateSettingsFilePreservingFormat`). Strings in settings expand `$VAR`, `${VAR}` and `${VAR:-default}` ([`packages/cli/src/utils/envVarResolver.ts`](https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/utils/envVarResolver.ts)).
- **Antigravity is a different client.** `~/.gemini/config/mcp_config.json` (and `~/.gemini/antigravity*`) belong to Antigravity; Gemini CLI does not read them for MCP. amem setup never reads or writes them, and `amem setup agy` stays repository-scoped.

## Native MCP commands

`gemini mcp add|remove|list|enable|disable` exist. `add <name> <commandOrUrl> [args...]` and `remove <name>` take `--scope user|project` (default `project`; `project` is refused when the cwd is the home directory) and `--transport stdio|sse|http` ([`packages/cli/src/commands/mcp/add.ts`](https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/commands/mcp/add.ts), [`remove.ts`](https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/commands/mcp/remove.ts)). Arguments after `--` are appended to `args`.

Observed in a scratch `HOME`/`GEMINI_CLI_HOME` with 0.61.0: `gemini mcp add --scope user --transport stdio amem <bun> -- --smol <entry> mcp` writes `mcpServers.amem = { "command": <bun>, "args": ["--smol", <entry>, "mcp"] }` and keeps unrelated keys (and comments) in `settings.json`; `gemini mcp remove --scope user amem` deletes only that entry and leaves `"mcpServers": {}`.

## Setup decision

`amem setup gemini` uses the native registration path, like Claude, Codex, Pi and Qwen:

- The native `gemini mcp add --scope user` runs in a private staging directory used as `HOME` and `GEMINI_CLI_HOME`, with the system settings paths redirected into it. A prior `amem` entry is removed with `gemini mcp remove --scope user amem` first. Only the produced server record is taken; every unrelated setting comes from the original file, and setup refuses if the native run changed any other MCP server.
- It owns only `mcpServers.amem`. Preview by default; `--apply`/`--undo` with a private receipt in `<memory-home>/setup/gemini.json`; idempotent re-apply; undo restores the original bytes when the file is untouched, otherwise removes only the managed entry and refuses if that entry was edited.
- Refused before any native call: settings that are not strict JSON (comments are valid for Gemini CLI but setup's byte-preserving restore needs strict JSON); a relative `GEMINI_CLI_HOME`; a Bun or entry path containing `$` (Gemini expands it); symlinked config paths.
- No hook and no instruction file (`GEMINI.md`) is installed or edited. `setup all` includes Gemini; when `gemini` is not on `PATH` it is reported and skipped.
- The verified layout version is 0.61.0; setup reports a different installed version as advisory.

Live check on this Mac (2026-10-31): with the real `gemini` 0.61.0 and a scratch `HOME` holding a settings file and an Antigravity `config/mcp_config.json`, `amem setup gemini --apply` added exactly the planned server and kept the other server and `ui` key; `--undo` restored the original bytes exactly; the Antigravity file was unchanged.

## Hooks

Settings-file hooks exist for `BeforeTool`, `AfterTool`, `BeforeAgent`, `Notification`, `AfterAgent`, `SessionStart`, `SessionEnd`, `PreCompress`, `BeforeModel`, `AfterModel` and `BeforeToolSelection`; input on stdin carries `session_id`, `transcript_path` and `cwd` ([`packages/core/src/hooks/types.ts`](https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/core/src/hooks/types.ts)). A `SessionEnd` hook would be the natural trigger for an ingest, but setup installs none because the transcripts are not eligible (below).

## Transcripts: not ingested

Sessions are JSONL at `<home>/.gemini/tmp/<project-id>/chats/session-<time>-<id8>.jsonl` (subagents nested under the parent session id), written by [`packages/core/src/services/chatRecordingService.ts`](https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/core/src/services/chatRecordingService.ts). The first record is session metadata (`sessionId`, `projectHash`, `startTime`, `kind`); message records are `{ id, timestamp, content, type, ... }` ([`chatRecordingTypes.ts`](https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/core/src/services/chatRecordingTypes.ts)).

`amem ingest gemini` is not provided:

- **No per-message origin.** Message records carry no `cwd`; origin exists only at file level (`projectHash` and the project directory key), and `/dir add` can widen a session to several directories (`directories`). Native ingest elsewhere in amem requires a per-message origin, the same reason Jcode and OpenCode are setup-only.
- **No stable cursor.** The file is not append-only history: `rewindTo` appends a `{"$rewindTo": <messageId>}` record that deletes every later message on load, and resuming a session whose file cannot be reloaded rewrites the whole file through a temporary file and rename. A byte or line cursor would replay or keep rewound content.

Upgrade path: a reader that replays `$rewindTo`/`$set` records like the native loader and treats a whole session as one origin, once amem accepts session-level origin for a session bound to one project directory.
