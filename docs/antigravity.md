# Antigravity setup research

Step 1 research, checked 2026-10-26. CLI/TUI (`agy`), the standalone IDE and the Antigravity App are distinct surfaces. A shared configuration path does not establish identical process or transcript behavior.

# Setup boundary

`amem setup agy` previews a repository-scoped MCP registration. `--apply` writes only the owned `mcpServers.amem` entry in `<repo>/.agents/mcp_config.json`, with an explicit absolute repository `cwd`. The repository is the real git toplevel of the setup working directory. Setup refuses outside a git repository or when the config is git-tracked, and warns when it is not ignored. It never writes the global Gemini configuration. `setup all` excludes agy; run it separately in each repository.

Private undo receipts are keyed by repository. Apply is idempotent; undo restores only that repository and refuses an edited owned entry. Unrelated configuration bytes are preserved. Only strict JSON is accepted: comments, trailing commas, BOM and duplicate owned keys refuse. A JSONC-preserving codec is the future upgrade for commented native files.

Restart Antigravity after setup. Use one workspace per session and ensure no other global, plugin or running server is named `amem`; setup can detect collisions only in the workspace file it reads. Native TUI/IDE launch and interactive completion remain unverified; the installed-package smoke initializes the registered MCP command directly.

No ingest kind or capture hook is installed. A supported offline transcript contract with row time, historical workspace origin and stable replay behavior would unlock ingestion. Current mounted workspace paths and completion readback do not prove historical origin.

# Evidence and version boundary

- Official public repository: [google-antigravity/antigravity-cli](https://github.com/google-antigravity/antigravity-cli). The checked revision is [`bf1e6e6d4a05803d21dbe9af5ffba04d8b4fc0ff`](https://github.com/google-antigravity/antigravity-cli/commit/bf1e6e6d4a05803d21dbe9af5ffba04d8b4fc0ff), whose changelog starts at CLI `1.4.7`. Its public tree contains documentation/examples, not the runtime MCP parser or spawn implementation.
- Current official web documentation is mutable and was read on the date above. It is not a source pin for every installed IDE version.
- Sibling agent-hub receipts cover isolated account-free CLI `1.4.2` and `1.4.7` plugin/hook transport. They do not verify amem, global MCP cwd, or the IDE. The 1.4.7 receipt records binary SHA-256 `b7a13e53c9f49921692676ef8edc2e60ceb67064c00bc732d9a364ec3ad75b32`.
- This task ran no native agy command and accessed no account, real Antigravity/Gemini home or private transcript. No installed-client acceptance is claimed.

# MCP configuration and project binding

The [official MCP guide](https://antigravity.google/docs/mcp) documents one shared global file for current CLI and IDE, `~/.gemini/config/mcp_config.json`, plus workspace-local `.agents/mcp_config.json`. Entries live under `mcpServers`; local stdio uses `command`, `args`, optional `env`, and an explicit `cwd` working-directory field.

amem binds its project from process cwd at startup. Its entry therefore needs an absolute, deliberately selected `cwd`; the guide does not establish an automatic workspace default or a workspace-variable template. A global entry pinned to project A remains bound to A when accessed from another window. It cannot be described as automatic per-window project discovery. A project-local entry must still specify cwd.

The [settings guide](https://antigravity.google/docs/settings?tab=cli) says a same-named already-running MCP server keeps its name across configuration sources. Do not assume a workspace or plugin entry overrides a global `amem` entry. Report collisions instead. CLI preferences in `~/.gemini/antigravity-cli/settings.json` are separate from MCP configuration.

The pinned [CLI changelog](https://github.com/google-antigravity/antigravity-cli/blob/bf1e6e6d4a05803d21dbe9af5ffba04d8b4fc0ff/CHANGELOG.md#L446) states that plugin MCP servers with relative or missing cwd resolve against the plugin directory. Merely putting amem inside `.agents/plugins/amem/` does not bind it to the workspace root.

# Registration, plugins and redirects

- The pinned [changelog](https://github.com/google-antigravity/antigravity-cli/blob/bf1e6e6d4a05803d21dbe9af5ffba04d8b4fc0ff/CHANGELOG.md#L599) confirms native MCP `add`, `remove`, `list`, `enable` and `disable`, including `--type`, `--env` and `--header`. Exact add argument ordering and a native cwd flag were not established from primary documentation; no argv was guessed or run.
- The [plugin guide](https://antigravity.google/docs/plugins?tab=cli) documents project `.agents/plugins/<name>/` bundles containing a manifest, `mcp_config.json` and `hooks.json`. Its CLI installation section names `~/.gemini/antigravity-cli/plugins/`, while its other sections and settings guide name `~/.gemini/config/plugins/`. This inconsistency is not a verified multi-directory discovery contract. Direct MCP setup need not install a plugin.
- The pinned changelog records MCP support for single-line and block comments plus trailing commas. A strict-JSON editor must explicitly refuse that valid native JSONC syntax or preserve it; it must not silently discard it.
- No Antigravity-specific config-home override, cwd template, variable-interpolation contract or account-free native staging contract was established. Do not borrow Gemini CLI environment variables or assume changing HOME alone isolates account/keychain behavior.

# Hook capability and capture boundary

The [official hooks guide](https://antigravity.google/docs/hooks?tab=cli) documents global `~/.gemini/config/hooks.json`, workspace `.agents/hooks.json` and plugin-local hooks. A named hook maps to event handlers. Events are `SessionStart`, `PreInvocation`, `PostInvocation`, `PreToolUse`, `PostToolUse` and `Stop`; `SessionEnd` is not documented. Tool events use matcher groups; the other events contain handlers directly.

Handlers execute shell commands. Timeout is seconds, default 30. JSON stdin uses camelCase fields including `conversationId`, `workspacePaths` and `transcriptPath`. `Stop` means execution-loop termination, not necessarily application shutdown; `fullyIdle` distinguishes unfinished background work. Passive capture must not inject steps or request continuation.

These fields do not establish per-row project origin. Multiple workspace paths and mutable conversation state require an independent supported transcript contract before ingestion. The guide describes `transcript.jsonl`, whereas the sibling 1.4.2 receipt observed `transcript_full.jsonl`. No stable row schema/version or cross-surface replay guarantee was established, so setup research does not authorize automatic historical capture.

# Sibling implementation context

The reviewed agent-hub files are `src/adapters/agy/{definition,entry,hooks}.ts` and `src/cli/agy-mcp.ts`. The launcher owns three project-plugin files, starts native agy in a project cwd, and supplies `AGENTHUB_PROJECT_DIR` explicitly to its MCP server. That environment binding makes its receipt unsuitable as proof of amem's native process cwd. The hub decoder's strict transcript allowlist and advisory hook behavior are integration-specific, not an Antigravity transcript specification.
