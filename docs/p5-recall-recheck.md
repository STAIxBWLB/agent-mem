# #13 AC4 pre-cutover recall re-measure (#82 G1a)

Owner decision 2026-10-26 (#82 D1): P5 waits for this measurement. Result, on the same imported copy:

- **Library `store.search`: recall@10 = 23/25 = 0.92** under the P1 strictness (25/25 counting the two borderline hits), above the 0.80 margin.
- **MCP `amem_search`, the path agents use: 18/25 = 0.72 strict, below the margin** (23/25 = 0.92 counting five borderline hits). See "MCP path" below.

The 2026-10-17 measurement (`docs/p1-ac4-recheck.md`) was 0.52 on the curated tier alone; the difference is the capture tier fed by the claude-mem capture import. The gap between the two paths is MCP's candidate selection at this capture volume, so P5 stays blocked until that is fixed and re-measured (#82 G1e).

## Method

- Engine: main 5e64b8d (0.9.1 library), `store.search(query, { project: "github.com/staixbwlb/agent-hub", limit: 10 })`, engine `fts5`, curated tier plus the project's capture shard. Same 25 frozen queries (`docs/p0-baseline.md` §3.4) and hit rule as P1: at least one of the first 10 results is directly on the query's subject, judged from the result's title or first line.
- Corpus: copies only, taken 2026-10-26. The amem home was copied with an APFS clone; the claude-mem database and its WAL files were cloned the same way. Neither live store was opened. The claude-mem copy's SHA-256 was the same before and after the import.
- D2 aliases (added in the copy only; the live home has no alias file yet, and alias review stays a person step of `docs/p5-cutover.md`): `work/dev/agent-hub` (69,803 observations) and `agent-hub` (11,533) mapped to `github.com/staixbwlb/agent-hub`. The ten worktree keys (`work/dev/agent-hub/.worktrees/*`, 30-245 observations each) were left unmapped, as a conservative review would.
- Import: `importClaudeMemCapture` with `days: 40` (the mapped observations run from 2026-09-19 to 2026-10-26), repeated until `more` was false (9 rounds): **86,257 read, 84,765 added, 1,492 skipped** by the standalone policy and secret screen, 0 spooled.
- Judgment: claude (planner), with the reviewer re-judging. The P0/P1 judgments were by kimi.

## Per-query outcome (H = on-topic entry in top 10; B = borderline)

| # | Query | P1 (curated) | G1a | Where the hit came from |
|---|---|:-:|:-:|---|
| 1 | seatbelt HFS+ ignorable code points .git | H | H | capture, rank 1: seatbelt HFS+ ignorable folding (#270) |
| 2 | review done never throw after approval write | - | H | capture: #243 review()/done() never throw after the approval write |
| 3 | escalation publish failure assignment delivery | H | H | curated #424 follow-ups and capture delivery-failure/escalation tests |
| 4 | peer_stop stop headless agent | H | H | capture, rank 1: headless peer_stop contract |
| 5 | upgrade restore blocked launcher session attach | H | H | curated #433, rank 1 |
| 6 | turn-free test silent waits | - | H | capture: #296 turn-free end-to-end test's silent waits |
| 7 | macOS CI flaky timing tests | - | H | capture and curated: macOS flaky-test tasks (#375, #376, #378) |
| 8 | usage_update context occupancy kimi | - | H | capture, rank 3: #285 Kimi usage_update context occupancy |
| 9 | permission modes grantablePath | - | H | capture: permission-mode policy and grantablePath defenses |
| 10 | codex resume restore owed native policy | H | H | capture: #270 part 2 restore owed to a resumed Codex thread |
| 11 | console task assignment revision queue | H | H | curated #424, rank 1 |
| 12 | kimi TUI pull-only headless ACP | - | B | curated #654 Kimi TUI launcher and capture peer start-mode (headless vs Kimi TUI); pull-only not on the titles |
| 13 | memory split agent-mem migration generation profile | H | H | curated #412/#15 T2 generation migration |
| 14 | candidate sidecar memory_correct counter | H | H | curated #412 P7a, rank 3 |
| 15 | cli output table columns color json | - | H | capture: shared --json/--columns/--color output-flag parser |
| 16 | office view dashboard pet window | H | H | curated #391/#394 |
| 17 | database busy timeout locked restart | - | H | capture, rank 1: #303 bounded busy timeouts and the locked-restart outcome |
| 18 | usage limit refusal quota pause reroute | - | B | curated #683 usage ledger with budget pause/resume; refusal and reroute not on the titles |
| 19 | submodule git directory sandbox | - | H | capture: sandbox submodule git-dir protection (#281) |
| 20 | hardened git helper fsmonitor hooksPath | H | H | capture: hardened git SAFE_CONFIG (hooksPath) |
| 21 | pi bounded spec access container check runner | H | H | curated #418 P0/P1 |
| 22 | chroma RSS admission blocked heavy job | H | H | capture: claude-mem chroma-mcp process and heavy-job admission blocks |
| 23 | work_state import lists | - | H | capture: claude-mem work_state schema and the #112 import contract |
| 24 | watchdog cancel overlap ACP prompt | - | H | capture: ACP watchdog-cancel path |
| 25 | realPath backslash ENOENT Bun | H | H | capture, rank 1: realPath Bun backslash ENOENT workaround |

Strict: 23/25 = 0.92 (B counted as misses, as P1 did with its two borderline cases). Lenient: 25/25 = 1.00. P1's 10 coverage misses are all hits or borderline now, and no P1 hit was lost.

## Checks

- **Query-text contamination.** The capture tier holds sessions that worked on this measurement itself. In each query's top 10, rows that contain two or more of the 25 query strings verbatim, or measurement terms (`recall@10`, `query set`, `P0 baseline`, `AC4 re`), were flagged: 1 row for query 22 and 2 for query 23, none counted as that query's hit. Every hit above stands without them.
- **Period.** claude-mem's 1.00 (P0) was on its store as of 2026-10-17; this capture holds observations through 2026-10-26. Both systems hold the same data at cutover, which is what P5 decides on.
- **Resources (copy, this Mac).** The import is a person-run CLI step, not a hook: 43 s, 303 MB peak RSS. The capture shard grew to 194 MB (`capture.db`); the whole home went from 33 MB to 226 MB, within the 512 MB capture cap (R6). Opening the store and running the 25 searches under `bun --smol` (the shipped MCP's flag) peaked at 127-141 MB in two runs, under the R3 200 MB peak; P6 still records the live MCP RSS (#13 AC2).
- **Duplicates.** Several top-10 lists repeat one entry (query 5: one curated task four times; query 11 the same). That is #82 G1b; it does not change this metric.

## MCP path

The same 25 queries through `amem mcp` (`bun --smol`, `AMEM_HOME` on the copy, cwd in the agent-hub checkout) with `tools/call amem_search {query, limit: 10}`. The top 10 shares only 1-8 of 10 results with `store.search`.

| # | MCP | Note |
|---|:-:|---|
| 1, 3, 4, 5, 7, 8, 9, 10, 11, 13, 14, 15, 16, 20, 21, 22, 24, 25 | H | 3, 10 and 22 by the P1 precedents (#424 follow-ups, #273 owed native, #110 P0 resource task) |
| 2 | B | done-to-approved "never throws after a write" row; the #243 row is not in the top 10 |
| 12, 18 | B | as in the library table |
| 17 | B | agent-mem busy_timeout and "database is locked" rows; the hub #303 rows are not in the top 10 |
| 23 | B | #112 P2 work lists and #383 work-list follow-ups |
| 6 | - | the #296 turn-free silent-waits rows rank first in `store.search` but are not in the MCP top 10 |
| 19 | - | submodule rows without the sandbox subject; the #281 sandbox rows are missing |

Why the paths differ: `amem_search` (src/mcp-memory.ts) screens each tier's rows before selection (the P2 contract) and keeps at most `SEARCH_CANDIDATES` = 5,000 permitted candidates per tier in page order, then ranks them in an in-memory index. With 84,765 capture rows, a broad query matches more rows than that, and the precise older rows can be cut before ranking. `store.search` ranks the whole shard. Each MCP search also took 1.8-5.9 s on this corpus (65 s for the 25 calls), against 2-3 s for the 25 library searches.

## What this means for P5

The coverage gap of `docs/p1-ac4-recheck.md` closes in the library once the person's alias review maps the claude-mem keys and the `--capture-days` import runs. Agents recall through MCP, and that path is at 0.72 strict. P5 waits for #82 G1e (MCP candidate selection at real capture volume) and a re-run of this MCP measurement. The import step's aliases should match the two keys above. P6 re-measures the same 25 queries on the live home after the cutover.
