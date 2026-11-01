# Transcript summaries: verification boundary

Issue #201 captures Claude Code's existing titles, recaps and compaction summaries without a model call, network request or additional model tokens. The source measurement head is `e5a2ef1744590e5678a28f0cf5c57dbede7c642b`, rebased onto main `202e46b`, including #208's format-3 spool and #198's RSS accounting. The private 70-query replay (AC6) belongs to the reviewer and was not accessed by the implementer. Hosted CI and native-client acceptance are separate from these dgx02 fixture checks.

[The numeric receipt](transcript-summaries-201.json) retains the final physical summary samples, runner probes, earlier receipt and all subsequent attempts. Raw logs and public retrieval reports are on the dgx02 development-container home volume under `/home/dev/tmp/amem-201/`. No resource failure or withdrawn design is treated as a passing acceptance run.

## Partial-index design choice

A controlled probe used the same 500,001-row capture store (50,000,123 declared row bytes, 68,300,800 physical database bytes). With no summary, brief generation took 4.545 ms using the partial index and 11.313 ms using the bounded fallback. One-time partial-index construction took 32.938 ms. With an older recap outside the recent window, the indexed brief took 4.642 ms and rendered the recap; the fallback took 4.267 ms and could not reach it. Raw evidence: `partial-index-comparison/result.json`.

The final implementation uses the simpler ordinary partial index, `rows_brief_summaries_v1`, over project/time/id for main-session Recap/Compact rows. The custom derived summary table and its triggers were withdrawn. Existing FTS infrastructure is unchanged. A published 0.18.0 writer test verifies that ordinary SQLite index maintenance keeps the summary view current.

A hook may create the partial index only when a bounded count sees at most 128 rows. The count and creation share one immediate transaction, preventing a concurrent older writer from making that decision stale. Large legacy stores use at most 128 recent rows, report partial coverage, and defer index construction to an off-hook capture query. Native brief reads never build an index. Indexed reads load at most 33 summary bodies. The one-time 32.938 ms build is characterized separately and is not hidden inside the hook gate.

## Resource measurements

The final source passed the unchanged R1/R2 and R3 harnesses on their first group attempts. There were no stalled samples, retries or optional-worker deferrals. R1 observed and reaped 136 invocations and 136 owned children. Ordinary R2 includes the real jcode hook path added by #208.

`bun scripts/measure-transcript-budget.ts` measures 40 Stop, 40 SessionEnd and 40 cold-home burst invocations. Each sees a fresh 256 KiB tail containing all three summary kinds; the burst adds 100 distinct titles. Cursor progress and durable capture are checked outside the timed invocation. Every physical sample names its RSS provenance. Thresholds, global deadlines and retry policy are unchanged: wall p95 below 150 ms and peak RSS below 100 MB.

| Hook workload | Runs | Wall p95, ms | Peak RSS, MB |
|---|---:|---:|---:|
| Stop | 40 | 97.30 | 80.50 |
| SessionEnd | 40 | 98.10 | 80.50 |
| Stop burst | 40 | 119.45 | 73.50 |
| Ordinary plain | 40 | 79.53 | 77.86 |
| Contended spool/exit | 15 | 77.98 | 71.75 |
| SessionStart | 20 | 63.92 | 44.61 |
| SessionStart repository log | 20 | 67.66 | 45.50 |
| Drain | 1 | 81.32 | 71.75 |
| jcode | 40 | 77.15 | 71.75 |

Linux RSS uses the merged #198 production-owned-images measurement and fails closed for unknown provenance. Coverage is `images: bun+supervisor; descendants: not measured`. Raw combined RSS and outer CLI wait4 RSS remain diagnostics. These figures are not whole-process-tree measurements. The remaining coverage spelling, descendant characterization and literal post-merge-main ten-run series belong to task 83.

R3 idle/peak RSS were 36.75/157.60 MB; its separate large capture-volume run peaked at 103.96 MB, under the unchanged 100 MB idle / 200 MB peak limits. Raw final reports: `final-acceptance/measure-transcript-budget.log`, `measure-hooks-budget.log` and `measure-mcp-budget.log`.

## Public retrieval no-loss gate

The public LongMemEval S and M datasets each contain 500 questions. The unchanged comparator uses strict BM25 controls against baseline `5d4ce38b9622f9561a38ad718d7d540055d4800b`. Dataset hashes and commands are in [longmemeval.md](longmemeval.md), with identities also retained in the historical numeric receipt. Final reports and comparisons are recorded under `final-acceptance/`. Their completion and no-loss verdict are included in the PR delivery report, after these documentation bytes were frozen.

The public harness seeds ordinary user/assistant rows directly, without summary rows. It checks retrieval compatibility; focused tests establish summary ranking and brief selection. No target gain, private replay result or adoption claim follows from public no-loss results.

## Functional and standard checks

At the final source head, typecheck and boundary passed, and 43 focused tests passed with 280 assertions. Coverage includes all three native summary shapes; timestamp carry; repeated titles and A-B-A transitions; incremental reads; rotation/truncation; deterministic receipts; envelope/text screens before caps; denied canonical paths; private spans and subagents; oversized and incomplete lines; actual CLI hooks and offline tripwires; format floors; 0.18.0 maintenance coexistence; summary weighting; brief byte quotas and legacy byte invariance.

An additional 19 focused tests (103 assertions) cover the partial index, published older writers, real legacy schemas, no-FTS substring queries, concurrent index admission and the CLI/MCP lazy-import boundary. Final standard-gate results are reported with the delivery head; source-measurement logs remain under `e5a2ef1/`.

## Retained attempt history

The numeric receipt preserves the original public S/M no-loss results and all pre-integration resource data, including both burst RSS failures. It also names every later suite and diagnostic directory.

| Head or directory | Outcome and disposition |
|---|---|
| `f5510a8`, `5a1ee36`, `cd6038a` | Earlier focused, standard and resource passes; inherited evidence, superseded by integrated checks |
| `d925e3b` | Full run stopped after two numeric source-anchor failures; corrected diagnostic anchors, unchanged assertions/timeouts |
| `ea5fc73` | Burst 117.71 ms / 101.50 MB, RSS failure before #198 |
| `04df65e` | Eight-admission experiment, burst 112.65 ms / 129.50 MB, 14 over-limit samples; ceiling withdrawn |
| `integrated/` | Integrated focused and summary R2 pass, before final cursor/index corrections |
| `9094ad0` | One equal-time ordering test assertion failed; corrected to verify count/idempotence |
| `b09a488/` | Focused pass; 500,001-row residual scan 128.595 ms motivated indexed lookup |
| `59c554f` | One older-writer fixture lacked project identity; fixture corrected |
| `legacy-index-fixed/` | Focused and summary R2 pass with custom summary table/triggers; design withdrawn |
| `acceptance/` | Summary R2 failed closed on one unavailable provenance count at 76.109 MB; no retry, later gates did not run; trigger design withdrawn |
| `partial-index-comparison/` | Controlled comparison above selected the ordinary partial index |
| `partial-index/` | Focused and summary R2 pass on the selected design before the atomic small-store guard |
| `partial-acceptance/` | Focused, ordinary R2, R3 and complete S no-loss pass; M stopped at 170/500 when the guard changed source, not accepted as complete |
| `partial-full/` | 2,420 pass / 7 skip / 3 fail; legacy-schema fixtures and CLI-only allowlist corrected, assertions/deadlines retained |
| `atomic-index/` | Generic test-spy typing error corrected |
| `e5a2ef1/`, `final-acceptance/` | Final source checks, physical samples and complete retrieval reports |

## Limits

Each invocation reads at most 256 KiB. The native caller allocates at most 60 ms for scanning with a 20 ms publication reserve inside the existing deadline. Incomplete lines wait; a line exceeding the ceiling is skipped through its newline and counted once as `transcript_line_bound`. Existing policy structural bounds may refuse a large summary before clipping. A full spool stops cursor progress at the unadmitted row; later final hooks retry the tail. A busy cursor or failed transcript read leaves ordinary capture available.

Private cursor databases contain hashes and file/offset/timestamp metadata, never transcript paths, raw session identifiers or summary text. They have a 1 MiB bound. Stable byte positions distinguish untimed A-B-A title transitions while full-file rotation/copy receipts remain idempotent; arbitrary historical rewrites that move identical untimed lines have no intrinsic stable source ID. Capture row schema, hashes and paths are unchanged. Summary rows use shared format 3; ordinary Claude rows remain format 2.
