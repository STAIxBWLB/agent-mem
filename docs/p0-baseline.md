# P0 baseline: claude-mem inventory, resources and retrieval (2026-10-17)

Frozen measurements for issue #13 P0 (R1-R6, AC4), taken on the primary Mac against the live
claude-mem 13.40.0 installation and an unmodified copy of the amem home (`~/.agenthub/memory`,
agent-mem 0.3.0, generation profile). Workspace plan: entelecheia/ai-workspace#53.

Method bounds kept: `~/.claude-mem` was read-only for every measurement (the DB was opened
`mode=ro`; SHA-256 of `claude-mem.db` recorded before and after, see §5). No claude-mem process
was killed, started or restarted. amem search ran against a copy of the home so no index or
promotion write could touch the live one. The report contains tool names, counts and titles of
memory entries only; no note bodies, prompts or PII.

## 1. Inventory

### 1.1 MCP tool invocations, last 14 days (2026-10-03 to 2026-10-16), from transcripts

Actual invocations only (`"type":"tool_use"` in Claude transcripts, `"type":"function"` in Kimi
wire logs; bare name matches in session files are tool-catalog listings and were excluded).
Codex rollouts contain no claude-mem MCP calls at all: codex reaches claude-mem only through its
plugin hooks and the transcript watcher.

| Tool | Claude | Kimi | Codex |
|---|---:|---:|---:|
| work_state_write | 407 | 12 | 0 |
| search (legacy index) | 57 | 10 | 0 |
| get_observations | 24 | 4 | 0 |
| mem_search (guided) | 16 | 10 | 0 |
| work_state_read | 15 | 0 | 0 |
| smart_outline | 0 | 4 | 0 |
| timeline | 0 | 1 | 0 |
| save_memory | 0 | 1 | 0 |
| smart_search, smart_unfold | 0 | 0 | 0 |
| build/prime/query/rebuild/reprime/list_corpus, session_start_context, important_workflow, get_tool_uses | 0 | 0 | 0 |
| **total** | **519** | **42** | **0** |

Claude names the server `mcp__plugin_claude-mem_mcp-search__*`, Kimi `mcp__claude-mem__*`.

### 1.2 Hook and capture use, last 14 days, from the claude-mem DB (read-only)

SessionStart hook (sessions recorded) per platform:

| Platform | Sessions (14d) |
|---|---:|
| claude | 3,320 |
| codex | 702 |
| kimi | 352 |
| qwen | 54 |
| agent-hub | 21 |
| copilot | 18 |
| kiro | 13 |
| pi | 4 |
| **total** | **4,484** |

PostToolUse capture (observations written) per day, with `discovery_tokens`:

| Day | Observations | discovery_tokens |
|---|---:|---:|
| 2026-10-03 | 6,488 | 302,887,856 |
| 2026-10-04 | 3,406 | 167,577,967 |
| 2026-10-05 | 8,510 | 425,508,371 |
| 2026-10-06 | 2,385 | 107,348,877 |
| 2026-10-07 | 4,564 | 222,437,294 |
| 2026-10-08 | 4,837 | 250,462,769 |
| 2026-10-09 | 9,446 | 481,268,824 |
| 2026-10-10 | 10,661 | 529,969,999 |
| 2026-10-11 | 11,749 | 599,654,701 |
| 2026-10-12 | 6,707 | 317,757,642 |
| 2026-10-13 | 5,985 | 287,930,742 |
| 2026-10-14 | 4,220 | 168,306,419 |
| 2026-10-15 | 2,260 | 103,412,617 |
| 2026-10-16 | 3,660 | 154,608,933 |
| 2026-10-17 (partial) | 98 | 4,171,930 |

14-day volume: 84,978 observations, ~4.12 B discovery_tokens; full-day median 5,159
observations/day, mean ~294 M discovery_tokens/day. All-time: 204,470 observations,
5.04 B discovery_tokens (matches #412 E1). `work_state_entries` (as of ~09:20 KST, live DB):
4,171 rows over 592 distinct project+list pairs; replaying each row (latest write wins,
`dropped` removes the item, `status: done` on the list closes it) gives 201 open and 391
closed lists, with 22 todo + 30 doing + 1 review open items in the open lists.

### 1.3 Keep/drop proposal per claude-mem function (issue #13 inventory)

| Function | Evidence here | Proposal |
|---|---|---|
| Setup hook | install-time | **Keep** as the `amem` plugin manifest (P3) |
| SessionStart hook (context injection) | 4,484 sessions/14d | **Keep** as bounded, token-capped brief (P3) |
| SessionStart work_state display | 592 lists | **Keep** via work lists (P2, C) |
| UserPromptSubmit hook | part of capture volume | **Keep** as capture event (P1, R4) |
| PreToolUse hook | no memory consumer found; permission decisions belong to the host (agent-hub facts-hook) | **Drop**, say so in P3 docs |
| PostToolUse / PostToolUseFailure hooks | ~6,070 observations/day | **Keep** as deterministic capture (P1, R4) |
| Stop / SessionEnd hooks | session lifecycle | **Keep** as `amem ingest` trigger points (P3) |
| MCP mem_search / search | 109 invocations/14d | **Keep** as `amem mcp` search (P2) |
| MCP timeline | 1 invocation/14d | **Keep** (read tool, P2) |
| MCP get_observations | 28 invocations/14d | **Keep** as show (P2) |
| MCP smart_outline / smart_search / smart_unfold | 4 invocations/14d, code-structure not memory | **Drop** from the memory package; hosts can offer them elsewhere |
| MCP corpus tools (build/prime/query/rebuild/reprime/list) | 0 invocations/14d; LLM knowledge-agent feature, conflicts with R1/R4 | **Drop** |
| MCP session_start_context, important_workflow | 0 direct invocations/14d | **Fold** into search/brief internals, not separate tools |
| MCP get_tool_uses | 0 invocations/14d; raw tool I/O | **Drop** (capture-tier search covers the need, P2) |
| MCP work_state_read/write | 534 invocations/14d | **Keep** as work lists (P2, C) |
| MCP save_memory | 1 invocation/14d | **Keep** bounded, writes to candidates (P2) |
| Transcript bridge (launchd) + cross-Mac sync | 702 codex + 352 kimi + 94 other sessions/14d captured | **Drop** as daemons; `amem ingest` + git sync replace them (R1, P3) |
| agent-hub worker HTTP client (`client.ts`, `capture.ts`) | 21 agent-hub sessions/14d | **Drop**; agent-hub uses the library (F, P4) |
| Chroma vector store | 4.4 GB RSS, 7.3 GB disk | **Drop** (R5: FTS5; embeddings only on AC4 evidence) |
| LLM observer per tool event | ~294 M discovery_tokens/day | **Drop** from the capture path (R4); optional capped summarization only |

## 2. Resource baseline

### 2.1 Process RSS, sampled every 60 s for 61 min (2026-10-17 09:18-10:19 KST), `ps`

| Process | Role | Samples | RSS min/median/max |
|---|---|---:|---|
| `worker-service.cjs` (bun) | claude-mem worker daemon | 62 | 172 / 213 / 222 MB |
| `chroma-mcp` (python, uvx) | Chroma vector server | 62 | 3.74 / 4.17 / 5.24 GB |
| `uv tool uvx` (launcher) | chroma parent | 62 | 16 / 16 / 33 MB |
| `transcript-watcher.cjs` | cross-CLI watcher | 62 | 52 / 58 / 68 MB |
| `mcp-server.cjs` (per agent session) | MCP stdio server | 1,244 (19-21 concurrent) | 27 / 31 / 68 MB each |

Live findings: the Chroma server grew from 3.7 GB to 5.2 GB RSS during the single sampled hour
(on top of the #13 evidence of 4.0 GB over 11 h), the worker held ~0.2 GB, and 19-21 concurrent
agent sessions each carried their own ~30-70 MB `mcp-server.cjs` (~0.6 GB in total). The
whole claude-mem footprint summed to a median of 5.2 GB RSS (max 6.3 GB) across the hour. Four
short-lived small `worker-service` processes also appeared and exited (CLI invocations). This
is the resident footprint R1-R3 remove: amem has no daemon, and its MCP server is the stdio
child that exits with the session.

### 2.2 Disk

| Path | Size |
|---|---:|
| `~/.claude-mem` total | 11 GB |
| `~/.claude-mem/chroma` | 7.3 GB |
| `~/.claude-mem/claude-mem.db` (+wal/shm) | 2.4 GB |
| `~/.claude-mem/logs` | 662 MB |
| `~/.claude-mem/backups` | 487 MB |
| `~/.agenthub/memory` (amem home) | 9.7 MB |

### 2.3 Tokens

See the per-day table in §1.2: ~294 M `discovery_tokens`/day (LLM observer per tool event),
5.04 B all-time. R4 removes this class of cost from the capture path.

## 3. Retrieval baseline

### 3.1 Method

25 queries taken from the last two weeks of agent-hub work (the project both stores actually
cover). For each query, recall@10: a hit means at least one of the first 10 results is directly
on the query's subject, judged from result titles only.

- claude-mem: the same search the hub and MCP clients use, `GET /api/search?query=...&limit=10`
  on the running worker, unfiltered (global), which is its native strength.
- amem: `MemoryStore.list({ project, q, limit: 10 })` (0.3.0 substring search, project-scoped)
  against the copied home: 161 curated notes, all agent-hub project.

### 3.2 Result

| System | Hits | recall@10 |
|---|---:|---:|
| claude-mem | 25/25 | 1.00 |
| amem 0.3.0 | 5/25 | 0.20 |

Per-query table in §3.4. Follow-up single-term probes on the 20 amem misses separate the two
causes:

- **Match mode.** amem's `q` is one contiguous substring, so a natural multi-word query misses
  notes whose titles carry the same words in another order (e.g. the #270 seatbelt notes exist
  but "seatbelt HFS+ ignorable code points .git" is not a substring of any entry). FTS5 with
  BM25 (R5) addresses exactly this.
- **Coverage.** For several topics (peer_stop, flaky CI, usage_update, grantablePath,
  submodule, fsmonitor, work_state) the young curated store holds no on-topic entry at all:
  161 notes over ~6 weeks of agent-hub tasks versus 204k captured observations. Entries absent
  from the store cannot be recalled at any rank; the capture tier (P1, A) is what closes this.

### 3.3 Proposed margin for AC4

On this frozen 25-query set: **amem recall@10 at least claude-mem's minus 0.20** (i.e. >= 0.80
here), re-measured after P1 (FTS5 search). If amem lands below that, the gap and the embedding
revisit decision are recorded per R5, with the match-mode and coverage contributions
distinguished as in §3.2.

### 3.4 Query set and per-query outcome (H = on-topic entry in top 10)

| # | Query | claude-mem | amem |
|---|---|:-:|:-:|
| 1 | seatbelt HFS+ ignorable code points .git | H | - |
| 2 | review done never throw after approval write | H | - |
| 3 | escalation publish failure assignment delivery | H | - |
| 4 | peer_stop stop headless agent | H | - |
| 5 | upgrade restore blocked launcher session attach | H | H |
| 6 | turn-free test silent waits | H | - |
| 7 | macOS CI flaky timing tests | H | - |
| 8 | usage_update context occupancy kimi | H | - |
| 9 | permission modes grantablePath | H | - |
| 10 | codex resume restore owed native policy | H | - |
| 11 | console task assignment revision queue | H | H |
| 12 | kimi TUI pull-only headless ACP | H | - |
| 13 | memory split agent-mem migration generation profile | H | H |
| 14 | candidate sidecar memory_correct counter | H | H |
| 15 | cli output table columns color json | H | - |
| 16 | office view dashboard pet window | H | - |
| 17 | database busy timeout locked restart | H | - |
| 18 | usage limit refusal quota pause reroute | H | - |
| 19 | submodule git directory sandbox | H | - |
| 20 | hardened git helper fsmonitor hooksPath | H | - |
| 21 | pi bounded spec access container check runner | H | H |
| 22 | chroma RSS admission blocked heavy job | H | - |
| 23 | work_state import lists | H | - |
| 24 | watchdog cancel overlap ACP prompt | H | - |
| 25 | realPath backslash ENOENT Bun | H | - |

## 4. Unverified and limits

- Codex MCP use is zero by transcript evidence; if a codex setup registers the server under a
  different name than `mcp__claude-mem__*`, that use is invisible to this count.
- Hook counts are DB proxies (sessions for SessionStart, observations for PostToolUse), not
  hook-process invocations; a hook that fires and writes nothing is not counted.
- claude-mem search ran unfiltered (global), amem project-scoped; both are each system's native
  default, but the comparison is not symmetric in corpus (204k captured observations vs 161
  curated notes). §3.2's coverage note states the consequence.
- RSS sampling window covers one hour of ordinary use, not a full day; no restart or
  heavy-load point was induced.
- work_state counts are from a live DB and drift by a few rows per hour; they are marked
  with their reading time.

## 5. Read-only evidence

- `claude-mem.db` SHA-256 before: `ac42380963112aa532c3caae30620f6c2103319625f2a04ee8e440337d3a2478`
- `claude-mem.db` SHA-256 after: `fbd86b2b964c5897d304f3d26fd052b1819f5c2923ce8871b7901d202b6d9df7`
- The two hashes differ. Every measurement opened the DB `mode=ro` and wrote nothing; the
  claude-mem worker was live the whole window and checkpointed its WAL into the main file
  (the WAL and SHM hashes changed likewise). A byte-identical before/after is not achievable
  on a live DB; what the evidence shows is that no write came from measurement. For a frozen
  byte-level proof the worker would have to be stopped, which these bounds forbade.
