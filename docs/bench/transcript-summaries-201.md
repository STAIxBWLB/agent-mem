# Transcript summaries: verification boundary

Issue #201 captures Claude Code's existing titles, recaps and compaction summaries. It adds no model call or tokens. The private 70-query replay (AC6) belongs to the reviewer and is not accessed by the implementer.

## Checks

Focused tests cover native timestamps and title timestamp carry; incremental reads; repeated titles; rotation and truncation; content receipts; untimed fallback stability; full-text screens before excerpt caps; private spans; subagent attribution; symlink refusal; incomplete and oversized lines; actual Stop/SessionEnd hooks; network/provider tripwires; summary ordering and legacy brief invariance. Spool compatibility tests retain older-reader maintenance coverage and summary format boundaries.

`bun scripts/measure-transcript-budget.ts` measures the actual executable, 40 Stop and 40 SessionEnd invocations. Each sees a new 256 KiB tail containing all three summary kinds. The script verifies cursor progress and durable summary capture outside the timed invocation, reports every physical sample, and applies the existing 150 ms p95 and 100 MB peak limits through the existing runner-probe retry policy. This complements the unchanged ordinary R1/R2 harness and the R3 MCP harness.

## Limits

Each scan reads at most 256 KiB. An incomplete line waits for a subsequent invocation; one line exceeding that ceiling is skipped through its newline and counted once as `transcript_line_bound`. The existing standalone-policy structural bounds can refuse a large summary before clipping. A full spool stops cursor progress at the unadmitted row; ordinary hook capture can drain the backlog, and a later final hook retries the remaining tail. A busy cursor or failed transcript read never prevents ordinary hook capture.

Cursors contain hashes and numeric/file-identity metadata only, never transcript paths, raw session identifiers or summary text. Their SQLite files are private and checked against a 1 MiB bound; a cursor over that bound refuses further scans. Capture logs, schema and paths are unchanged. Summary records use the shared format-3 spool contract; ordinary Claude records remain format 2.

## Evidence status

The initial focused run at `f5510a8` passed typecheck, boundary and 22 focused/tripwire tests. Its first 80-invocation summary budget run passed. This is earlier-head evidence, not proof of the subsequent spool compatibility changes or task 80 integration.

A full run at `d925e3b` exposed a test instrumentation anchor affected by extracting the common publication helper. The numeric diagnostic's publication anchor was updated to the new expression; assertions, timeouts and resource limits remain unchanged. Final committed-head results and public LongMemEval S/M comparisons will be recorded in the PR. Hosted CI and the reviewer's private replay remain separate gates.
