# P1 AC4 re-check: FTS5 search against the frozen 25-query set

Date: 2026-10-17. Issue #13 AC4, re-measured after P1 (FTS5 search, `store.search`, engine `fts5`).
Baseline: `docs/p0-baseline.md` §3 (PR #17, branch `docs/p0-baseline`): claude-mem 25/25 (1.00), amem 0.3.0
substring 5/25 (0.20). Agreed margin (§3.3): amem recall@10 >= claude-mem − 0.20, i.e. **>= 0.80**.

## Result: 13/25 = 0.52 — below the 0.80 margin

| System | Hits | recall@10 |
|---|---:|---:|
| claude-mem (P0) | 25/25 | 1.00 |
| amem 0.3.0 substring (P0) | 5/25 | 0.20 |
| amem P1 FTS5 (this check) | 13/25 | 0.52 |

## Method (same as P0)

- Query set: the 25 frozen queries of `docs/p0-baseline.md` §3.4, verbatim (hardcoded in
  `scripts/ac4-recheck.ts`).
- Corpus: a filesystem copy of the live amem home taken 2026-10-17 (`cp -R`), opened read-only from the copy;
  the live home was never opened by the measurement. 192 live `agent-hub` views (P0 froze 161 earlier the
  same day; the home accrued notes meanwhile) plus 25 `halla-ai/ax-commons` views excluded by project scoping,
  as in P0. No capture-tier fixture: the copy holds no capture rows, matching P0's curated-only corpus.
- Search: `store.search(query, { project: "github.com/staixbwlb/agent-hub", limit: 10 })` on this branch,
  engine `fts5`. P0 used `MemoryStore.list({ project, q, limit: 10 })` (substring).
- Hit: at least one of the first 10 results is directly on the query's subject, judged from result titles
  only (P0 §3.1). Judgments below by kimi (implementer); the raw top-10 output of the run is reproducible with
  `bun scripts/ac4-recheck.ts --home <copy>`.

## Per-query outcome (H = on-topic entry in top 10)

| # | Query | amem P0 | amem P1 | Note |
|---|---|:-:|:-:|---|
| 1 | seatbelt HFS+ ignorable code points .git | - | H | #69 seatbelt note, rank 1 (seatbelt subject; not the HFS+ specifics) |
| 2 | review done never throw after approval write | - | - | coverage |
| 3 | escalation publish failure assignment delivery | - | H | #424 assignment/withdrawal follow-ups, rank 1 |
| 4 | peer_stop stop headless agent | - | H | #408 peer lifecycle/headless, rank 1 |
| 5 | upgrade restore blocked launcher session attach | H | H | #433 exact, rank 1 |
| 6 | turn-free test silent waits | - | - | coverage |
| 7 | macOS CI flaky timing tests | - | - | coverage ("flaky": 0 entries) |
| 8 | usage_update context occupancy kimi | - | - | coverage (0 entries for both terms) |
| 9 | permission modes grantablePath | - | - | coverage ("grantablePath": 0 entries) |
| 10 | codex resume restore owed native policy | - | H | #273 owed-native + #433 restore, ranks 5-8 |
| 11 | console task assignment revision queue | H | H | #424 exact, rank 1 |
| 12 | kimi TUI pull-only headless ACP | - | - | match mode, borderline: #450 I0 surfaces at rank 1, title not on-subject |
| 13 | memory split agent-mem migration generation profile | H | H | #412 P9 exact, rank 1 |
| 14 | candidate sidecar memory_correct counter | H | H | #412 P7a exact, rank 1 |
| 15 | cli output table columns color json | - | - | coverage |
| 16 | office view dashboard pet window | - | H | #391/#394 dashboard/pet/office, ranks 1-10 |
| 17 | database busy timeout locked restart | - | - | coverage |
| 18 | usage limit refusal quota pause reroute | - | - | coverage |
| 19 | submodule git directory sandbox | - | - | coverage |
| 20 | hardened git helper fsmonitor hooksPath | - | H | #412 P3 platform helpers (hardened git), rank 1 |
| 21 | pi bounded spec access container check runner | H | H | #418 exact, rank 1 |
| 22 | chroma RSS admission blocked heavy job | - | H | #110/#111: the P0/P1 tasks on this resource problem, ranks 1-5 |
| 23 | work_state import lists | - | - | match mode, borderline: #110 surfaces at rank 1, title not on-subject |
| 24 | watchdog cancel overlap ACP prompt | - | - | coverage |
| 25 | realPath backslash ENOENT Bun | - | H | #412 P3 platform helpers (realPath), rank 2 |

## Gap split (P0 §3.2 method)

Of the 12 misses:

- **Coverage: 10** (#2, #6, #7, #8, #9, #15, #17, #18, #19, #24). Single-term probes over the corpus find no
  on-topic entry at any rank (`flaky`, `usage_update`, `occupancy`, `grantablePath` return zero entries;
  `columns`, `busy`, `quota`, `submodule`, `turn-free`, `watchdog`, `never throw` return only off-subject
  entries). The curated store is 192 notes over ~7 weeks of agent-hub tasks; these subjects live in capture
  volume the curated tier never held.
- **Match mode: 2, both borderline** (#12, #23). An adjacent entry surfaces at rank 1 (#450 I0 multi-instance
  for the kimi pull-only query; #110 inventory-freeze for the work_state query) whose body is on-subject but
  whose title is not, so the strict title judgment marks a miss. No miss had a clearly on-topic entry buried
  below rank 10: FTS5+BM25 removed the P0 match-mode class (word order and partial term sets) entirely —
  every P0 hit is still a hit, and 8 of the 20 P0 misses are now hits.

## Embedding-revisit decision (R5)

Not warranted. The residual gap is dominantly coverage (10 of 12 misses): there is no on-topic entry to
retrieve by any match mode, and embeddings cannot change that. Match mode accounts for at most 2 borderline
misses, both of which semantic ranking would plausibly also surface with the same non-on-subject titles.
The recorded path to close the gap is the one P0 §3.2 named: the capture tier (this phase) feeding volume,
candidate promotion into the curated tier (P2), and the P6 live-week re-measure of this query set. If P6
still shows a match-mode gap after coverage improves, the opt-in, on-demand, no-resident-process embedding
revisit of R5 is re-opened with that evidence.

## Observations (not acted on in P1)

- Duplicate titles fill many top-10s (promoted copies and same-text task notes; e.g. query 5 shows the same
  entry four times). Deduping display-identical hits would raise effective recall diversity without changing
  this metric's letter; it predates this change and is left for a later phase.
- Judgment-borderline hits recorded above (#1, #10, #22) are counted H; #12 and #23 are counted misses with
  the same strictness. The margin outcome is unchanged under either call (11-15/25).
