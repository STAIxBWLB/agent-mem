# agent-mem

Curated memory with append-only JSONL logs, a derived SQLite index, short- and long-term tiers, a typed graph, goals with leases, and git sync between machines. Extracted from [agent-hub](https://github.com/STAIxBWLB/agent-hub), with compatible storage and entry IDs.

<!-- facts:version -->
Version: 0.39.0. Requires Bun 1.4.2 or later; runtime dependencies: @staix/cli-output.
<!-- /facts:version -->

## Quick start

Install the package, preview setup, then apply it for your client:

```sh
bun add -g @staix/agent-mem
amem --version
amem setup all
amem setup claude --apply
```

Replace `claude` with `codex`, `kimi`, `pi`, `qwen`, `jcode`, `opencode` or `gemini` for that client. The default command shows a read-only plan; `--apply` writes it without an interactive prompt. Complete the client's own hook-trust review when prompted.

Agents can submit pending memory candidates through MCP. Review each candidate with the CLI; acceptance and rejection recheck the configured policy and record the caller's actor and peer:

```sh
amem review list
amem review accept CANDIDATE_ID  # or: amem review reject CANDIDATE_ID
```

Replace `CANDIDATE_ID` with an id from the list. MCP remains proposal-only: it never accepts a candidate or writes a curated note.

Claude's registered hooks capture events during the session. The configured Codex/Kimi/Qwen SessionEnd hooks and Pi shutdown extension ingest transcript tails incrementally at session end. If those integrations are unavailable, run `amem ingest codex` (or `kimi` / `pi` / `qwen`) after each session, then repeat the review loop. The [setup section](https://github.com/STAIxBWLB/agent-mem/blob/main/docs/setup.md#setup--plugin) describes the registration and native trust steps.

From a checkout, install development dependencies with `bun install` and run `bun src/cli.ts --help`.

## Commands

| Area | Commands | Details |
| --- | --- | --- |
| Setup and hooks | `amem setup <client> [--apply\|--undo]`, `amem ingest <client>`, `amem completion <shell>` | [docs/setup.md](https://github.com/STAIxBWLB/agent-mem/blob/main/docs/setup.md) |
| Notes and review | `amem note add`, `amem review list\|accept\|reject\|walk\|decide\|targets`, `amem decay --propose`, `amem consolidate` | [docs/cli.md](https://github.com/STAIxBWLB/agent-mem/blob/main/docs/cli.md), [docs/recall.md](https://github.com/STAIxBWLB/agent-mem/blob/main/docs/recall.md) |
| Read and search | `amem list`, `amem search`, `amem show`, `amem graph`, `amem brief`, `amem eval` | [docs/cli.md](https://github.com/STAIxBWLB/agent-mem/blob/main/docs/cli.md), [docs/recall.md](https://github.com/STAIxBWLB/agent-mem/blob/main/docs/recall.md) |
| Health | `amem status`, `amem doctor`, `amem capacity`, `amem projects`, `amem usage`, `amem gc` | [docs/cli.md](https://github.com/STAIxBWLB/agent-mem/blob/main/docs/cli.md) |
| Sync and migration | `amem sync`, `amem migrate`, `amem prune`, `amem formats raise` | [docs/sync.md](https://github.com/STAIxBWLB/agent-mem/blob/main/docs/sync.md), [docs/curated-shard-migration.md](https://github.com/STAIxBWLB/agent-mem/blob/main/docs/curated-shard-migration.md) |
| Console | `amem setup console`, plugin for <!-- facts:console-pin -->`@staix/agent-console` 0.1.3<!-- /facts:console-pin --> | [docs/cli.md](https://github.com/STAIxBWLB/agent-mem/blob/main/docs/cli.md#console-acon) |

Bundled amem skills are previewed and installed alongside supported client setup. For other hosts, use `amem skills export <dir>`; see [setup](https://github.com/STAIxBWLB/agent-mem/blob/main/docs/setup.md) and [CLI](https://github.com/STAIxBWLB/agent-mem/blob/main/docs/cli.md).

Run `amem --help` or `amem <command> --help` for every option.

## MCP tools

<!-- facts:mcp-tools -->
12 tools, generated from `MCP_TOOLS` in `src/mcp.ts`:

| Tool | Read-only | Purpose |
| --- | --- | --- |
| `amem_search` | yes | Search screened memory in this project. |
| `amem_evidence` | yes | Return a bounded bundle of cited, live curated entries for a question. |
| `amem_show` | yes | Show a screened memory entry in this project by its exact id or unique prefix. |
| `amem_timeline` | yes | Read screened memory near an entry or time in this project. |
| `amem_brief` | yes | Read an intent/path-scoped brief of live public memory, ranked by requested-node matches up to three; fails lead among equal matches, followed by one-hop neighbours. |
| `amem_graph` | yes | Read the screened curated-memory neighbourhood. |
| `amem_work_state_read` | yes | Read project work lists; closed lists/items can be included explicitly. |
| `amem_work_state_write` | no | Append scalar project work-list fields; null clears, task selects an item, list status done closes. |
| `amem_remember` | no | Propose a memory candidate (text, optional kind/title), or kind=fail with approach, symptom, cause, evidenceRefs and retryWhen. |
| `amem_correct` | no | Propose a correction to an exact curated entry id visible in this project. |
| `amem_vault_candidates` | yes | List screened durable curated notes for review before moving them to a vault. |
| `amem_capacity` | yes | Read this machine's bounded capture capacity proposal; applying it requires the matching CLI preview and `--confirm`. |
<!-- /facts:mcp-tools -->

## Docs

- [Setup, hooks and native intake](https://github.com/STAIxBWLB/agent-mem/blob/main/docs/setup.md), with the per-client pages for [Jcode](https://github.com/STAIxBWLB/agent-mem/blob/main/docs/jcode.md), [Qwen Code](https://github.com/STAIxBWLB/agent-mem/blob/main/docs/qwen-code.md), [Gemini CLI](https://github.com/STAIxBWLB/agent-mem/blob/main/docs/gemini-cli.md), [OpenCode](https://github.com/STAIxBWLB/agent-mem/blob/main/docs/opencode.md) and [Antigravity](https://github.com/STAIxBWLB/agent-mem/blob/main/docs/antigravity.md)
- [CLI reference](https://github.com/STAIxBWLB/agent-mem/blob/main/docs/cli.md): configuration and privacy policy, review, console, capture and search, repo scope, project shards, doctor, library, session MCP
- [Recall, consolidation and records](https://github.com/STAIxBWLB/agent-mem/blob/main/docs/recall.md)
- [Generation migration, prune and sync placement](https://github.com/STAIxBWLB/agent-mem/blob/main/docs/sync.md), [curated shard migration](https://github.com/STAIxBWLB/agent-mem/blob/main/docs/curated-shard-migration.md)
- [Contracts](https://github.com/STAIxBWLB/agent-mem/blob/main/docs/contracts.md) and [purging a leaked entry](https://github.com/STAIxBWLB/agent-mem/blob/main/docs/purge.md)
- [Development and publishing](https://github.com/STAIxBWLB/agent-mem/blob/main/docs/development.md)

License: MIT.
