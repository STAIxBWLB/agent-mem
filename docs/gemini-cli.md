# Gemini CLI integration findings

Investigation for #176, started 2026-10-31. This is a partial discovery record; setup and ingest are not implemented yet.

## Installed client

- The installed `gemini --version` reports `0.53.1`.
- `/opt/homebrew/bin/gemini` points to the installed `@google/gemini-cli/bundle/gemini.js` package.
- Read-only help confirms `gemini mcp add`, `remove`, `list`, `enable` and `disable`.
- `gemini mcp add --help` advertises `--scope user|project` (default project), stdio/SSE/HTTP transports, environment entries and a timeout. `remove --help` also accepts user or project scope.
- Only version/help commands were run. No real configuration, native registration, session content or instruction file was changed.

## Configuration boundary

Gemini CLI uses `mcpServers` in user `~/.gemini/settings.json` or project `.gemini/settings.json`; its native MCP add command selects between them with `--scope`. Project settings override user settings. These paths are documented in the official [MCP guide](https://geminicli.com/docs/tools/mcp-server/#adding-a-server-gemini-mcp-add) and [configuration reference](https://geminicli.com/docs/reference/configuration/#settings-files).

The Antigravity registration at `~/.gemini/config/mcp_config.json` is a different client configuration. It is outside this target's ownership. Existing `amem setup agy` remains repository-scoped; see [P5 ownership](p5-cutover.md).

Native registration in an isolated HOME, unrelated-byte preservation and undo behavior have not been tested yet.

## Hooks

The official [hook reference](https://geminicli.com/docs/hooks/reference/) describes settings-file hooks, including SessionStart and SessionEnd; input is JSON on stdin, with JSON output and exit-code semantics. The full installed event list, payload fields and hook invocation behavior still need read-only verification before any capture hook is installed.

## Transcript eligibility remains unresolved

The pinned [0.53.1 recording types](https://github.com/google-gemini/gemini-cli/blob/v0.53.1/packages/core/src/services/chatRecordingTypes.ts) declare message ids, timestamps, content and message type. Project hash and session identity are conversation-level fields; no per-message working-directory/project field appears in the inspected message type. The pinned [recording service](https://github.com/google-gemini/gemini-cli/blob/v0.53.1/packages/core/src/services/chatRecordingService.ts) has JSONL/rewind/metadata record handling, but its cursor and origin semantics have not yet been fully inspected against the installed bundle and local file shapes.

No ingest eligibility decision has been made. A readable file and a current hook cwd alone are not evidence of the historical origin of every message. Remaining discovery includes the installed writer/storage/project-registry code, bounded local schema inspection without printing message content, cursor behavior under rewinds or replacements, and per-message origin provenance.
