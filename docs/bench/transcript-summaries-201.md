# Transcript summaries: verification boundary

Issue #201 captures Claude Code's existing titles, recaps and compaction summaries. It adds no model call or tokens. The private 70-query replay (AC6) belongs to the reviewer and was not accessed by the implementer.

## Public retrieval no-loss gate

At `5a1ee36ce2462543f48b49feacd90b7efd979f69`, both complete public LongMemEval datasets finished all 500 questions, with zero failures and 30 abstentions each. The unchanged comparator's 42 strict no-loss comparisons passed per dataset. Every reported aggregate and per-type metric equals the baseline at `5d4ce38b9622f9561a38ad718d7d540055d4800b`; maximum absolute delta is 0. No target gain or adoption claim follows.

Dataset identities and commands are in [longmemeval.md](longmemeval.md). [The numeric receipt](transcript-summaries-201.json) records dataset hashes, aggregates, resource results and source identities. Raw reports stay outside the repository at `/home/dev/tmp/amem-201/` on the dgx02 development-container home volume.

These are pre-integration measurements. The public harness seeds ordinary user/assistant rows directly, without summary rows; it checks retrieval compatibility. Focused tests check the new summary ordering, timestamp, screening, cursor and brief behavior. Later hook-path and brief-quota corrections are separate from this benchmark head. The final integration must verify that the portable-memory tree, MCP search implementation and four harness files retain the recorded object identities.

## Resource measurements

The same committed head passed the unchanged ordinary R1/R2 and MCP R3 harnesses on their first group attempts, without stalled samples or optional-worker deferrals. Ordinary R1 reaped all 96 observed invocations and children. R3 idle/peak RSS were 36.73/174.67 MB; its separate large capture-volume run peaked at 100.95 MB. These are Linux/Bun 1.4.2 fixture measurements, not native-client acceptance or a performance improvement claim.

`bun scripts/measure-transcript-budget.ts` measures 40 actual Stop and 40 actual SessionEnd CLI invocations. Each sees a fresh 256 KiB tail containing all three summary kinds. It verifies cursor progress and durable summary capture outside the timed invocation, prints every physical sample, and uses the existing runner-probe retry policy and unchanged limits (p95 below 150 ms, peak below 100 MB).

| Final hook | Runs | Wall p95, ms | Peak RSS, MB |
|---|---:|---:|---:|
| Stop | 40 | 87.95 | 78.75 |
| SessionEnd | 40 | 90.18 | 73.50 |

The initial `f5510a8` run also passed typecheck, boundary, 22 focused/tripwire tests and the 80-invocation summary budget; its peak was 99.75 MB. The initial stdout receipt and the later complete numeric receipt are distinct runs. No resource failure is discarded.

## Functional checks

At `5a1ee36`, typecheck, boundary and 59 focused/backlog/compatibility/tripwire tests passed. At `cd6038a`, typecheck and 18 tests across the two changed files passed, including the added brief-byte-quota and canonical deny-alias regressions.

Coverage includes native timestamps and top-level predecessor carry; repeated titles; incremental reads; rotation and truncation; content receipts and untimed fallback stability; full envelope/text screens before excerpt caps; private spans and subagents; denied canonical source paths; incomplete/oversized lines; actual final hooks; offline tripwires; summary weighting and legacy brief invariance.

A full run at `d925e3b` was stopped after two numeric test-instrumentation anchor failures caused by extracting the common publication helper. The diagnostic's source anchor was corrected, retaining assertions, timeouts and limits; the corrected focused run passed. Its partial log is retained as `full-test.log`.

The latest pre-integration full suite and packaging run at `cd6038a` is still in progress. Integration with task 80 / PR #208, the final combined gate, hosted CI and the reviewer's private replay are not yet verified.

## Limits

Each invocation reads at most 256 KiB. An incomplete line waits; a line exceeding that ceiling is skipped through its newline and counted once as `transcript_line_bound`. The existing standalone-policy structural bounds can refuse a large summary before clipping. A full spool stops cursor progress at the unadmitted row; ordinary hook capture can drain the backlog, and a later final hook retries the tail. A busy cursor or failed transcript read does not prevent ordinary hook capture.

Private cursors contain hashes and file/offset/timestamp metadata, never transcript paths, raw session identifiers or summary text. Their SQLite files have a 1 MiB bound; an oversized cursor refuses further scans. Capture logs, schema and paths are unchanged. Summary rows use the shared format-3 spool contract; ordinary Claude rows remain format 2.
