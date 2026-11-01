# Capture recall: input text, event weight and session representatives

Issue #196 adds a bounded Claude tool-input line, a fixed 1.25x conversational-event ordering weight, and one capture result per attributed session. It preserves the legacy unweighted non-capture cohort before refilling capture slots. Returned score fields retain their previous meaning. Missing session hashes are independent groups.

The original measurements below are retained. The latest post-review iterator/recency correction and renewed retrieval evidence are in the task 77 section at the end.

## Measurement boundary

These are retrieval and resource checks, not an adoption claim. The private 70-query transcript comparison (AC6) belongs to the reviewer and was not accessed by the implementer.

The existing public LongMemEval harness creates rows directly through CaptureStore with `user`/`assistant` role events and no session hashes. Consequently it exercises legacy retrieval compatibility, but does not exercise Claude hook input enrichment, the Stop/UserPromptSubmit boost, or attributed-session collapse. Focused hook and ranking tests cover those behaviors.

## Public retrieval no-loss gate

The complete S and M datasets, their hashes and the strict controls are documented in [longmemeval.md](longmemeval.md). Both baseline runs at `15a3dc95c25d11e36a94ccaf65025ab8aa2afc4f` completed all 500 questions, including 30 abstentions, with zero failed questions. Runs use dgx02, Linux, Bun 1.4.2 and the unmodified public harness. Each backend reads the same stored rows; there is no model or network call in retrieval.

Both candidate runs at `9d9da274b3f744dc5c2e39d9fc5051cf2dfacb43` completed 500 questions with zero failures. All overall and per-type metric values equal the baseline. The unchanged comparator's strict controls and all 42 no-loss comparisons per set pass, with maximum absolute delta 0. No BM25-control waiver or target-gain claim applies; the comparator's target-gain verdict is not an adoption decision for this change.

| Set | Backend | Session all@10, baseline = candidate | MRR, baseline = candidate | ndcg_any@10, baseline = candidate |
|---|---|---:|---:|---:|
| S | MCP | 0.8659574468 | 0.8916400500 | 0.5570083364 |
| S | Library | 0.8659574468 | 0.8916237667 | 0.5567955683 |
| M | MCP | 0.7106382979 | 0.7854706435 | 0.4150726459 |
| M | Library | 0.7170212766 | 0.7843312823 | 0.4158925008 |

Values in the table are rounded; [capture-recall-196.json](capture-recall-196.json) retains the aggregate values and guardrail summaries. Comparisons use `bun scripts/longmemeval-compare.ts --baseline FILE --candidate FILE --bm25-control strict --json`, with no target types. The full S/M runs use the commands and dataset hashes in [longmemeval.md](longmemeval.md).

During measurement, main gained the independent Recap panel (`75d2d8b`). It was integrated at `6d03529e650bf893eb5b188b8d91468d7ce10881`, retaining the original benchmark commit in the branch history. All seven capture/search implementation files affected by #196 are byte-identical between the measured and integrated heads. Integration changes SessionStart/console code; the standard final checks include that integration. These distinctions do not turn the old-head benchmark into a claimed final-head run.

## Resource evidence

The unmodified R2 hook gate at `c173178162831d52eabcd7a7af1e67e8a1fd0819` failed its 100 MB peak RSS ceiling during the plain workload, before the independent R3 and retrieval checks ran. It emitted no numeric peak. This first failure is retained.

A predeclared diagnostic experiment alternated three fresh baseline runs with three fresh candidate runs in one dgx02 container. The only diagnostic patch added numeric CLI/recorded RSS to the existing failure message, on both source trees. Limits, sample counts, retry rules and assertions were unchanged. All six outcomes are retained:

| Sample | Baseline `15a3dc9` | Candidate `c173178` |
|---|---|---|
| 1 | Fail: SessionStart timeout-path RSS 148.75 MB | Fail: plain RSS 103.25 MB (CLI 36.75 MB) |
| 2 | Pass: all R1/R2 checks | Fail: plain RSS 106.75 MB (CLI 38.5 MB) |
| 3 | Pass: all R1/R2 checks | Fail: old fixture accounting found 0 of 55 enriched excerpts |

The accounting failure was a measurement-fixture incompatibility: anchored checks expected the bare response, while tool captures now contain `src/public.ts` followed by the response. Commit `9d9da274b3f744dc5c2e39d9fc5051cf2dfacb43` updates the exact per-event expectations and adds numeric RSS failure diagnostics. It changes no budget, sample count, timeout, retry rule or production code. One run after that correction still failed plain invocation 1: 90.26 ms wall, CLI RSS 36.75 MB, production combined RSS 126 MB, raw combined RSS 73.5 MB. That run failed; the baseline failures do not establish that the candidate failures are inherited.

After main integration changed the SessionStart path, one fresh run of the same existing R2 harness at `6d03529` passed on its first group attempt, with no stalled samples or worker deferrals. Limits and retry rules remain unchanged. The earlier failures remain part of this receipt; plain RSS is close to its ceiling and requires current-head CI confirmation.

| Workload | Runs | Wall p95, ms | Peak RSS, MB |
|---|---:|---:|---:|
| Plain | 40 | 73.52 | 99.75 |
| Spool and exit | 15 | 72.55 | 73.50 |
| SessionStart | 20 | 64.58 | 70.00 |
| SessionStart with repository log | 20 | 67.16 | 75.25 |
| Drain | 1 | 79.91 | 71.75 |

Both real timeout paths passed: SessionStart 128.28 ms / 78.75 MB, PreToolUse 117.32 ms / 73.50 MB. R1 found zero remaining processes across 96 invocations and 96 owned children.

A separate three-pair import/allocation probe found 21 MB peak after importing capture-input on both baseline and candidate; one input-line call raised the candidate peak to 21-22.75 MB. This small isolated probe does not measure the complete hook or establish the cause of its intermittent combined-RSS failures. No sanitizer, policy or resource accounting was changed in response.

The independent existing R3 MCP harness passed at `9d9da27`: idle RSS 34.93 MB, peak RSS 142.54 MB, within its unchanged 100/200 MB ceilings, and clean EOF reaping. It exercised 5,001 curated notes, 5,001 captures and 10,001 work rows. This does not override the R2 failure.

Raw public reports and measurement logs remain outside the source tree under `/home/dev/tmp/amem-196-capture` on the dgx02 development-container home volume. Diagnostic logs are in `r2-attribution/`; corrected-harness logs and reports use the `9d9da27-` prefix. The integrated R2 run is `integrated-r2.log`.

## Review recheck and RSS component attribution

The reviewer accepted shorter dense results on exhaustion: no duplicate, null or fake fillers, no additional curated notes; preserve the curated cohort and relative order, and exact slots whenever sufficient capture groups exist. A direct library/MCP regression now covers three same-session captures ahead of two older curated notes and asserts exactly three returned hits.

The following three unmodified R2 runs at `db272294638dcde648785aa9a0ba0feeda4f880f` were declared in advance and all retained. Every workload, real timeout path and R1 check passed on the first group attempt. They are additional observations, not replacements for the failures above.

| Run | Outcome | Plain p95, ms | Maximum workload RSS, MB | Maximum timeout RSS, MB |
|---|---|---:|---:|---:|
| 1 | Pass | 76.82 | 77.00 | 73.50 |
| 2 | Pass | 73.89 | 78.75 | 75.25 |
| 3 | Pass | 75.73 | 77.00 | 70.00 |

A separate three-run component trace also passed, but was instrumented and is not unmodified gate evidence. It established a variable accounting path in the existing native helper sampler:

- `hook-native.ts` uses Linux `ownPeak || raw`. A dash helper was observed with `VmHWM = 0`, causing its reaped `raw` value of 37,632 KiB to enter combined accounting. Other helpers had a nonzero image peak of 1,792 KiB despite reaped raw values of 28,672-37,632 KiB.
- In one traced SessionStart, parent image peak 39,424 KiB plus origin fallback 37,632, metadata image peak 1,792 and signature image peak 1,792 produced 80,640 KiB (78.75 MB). A nonzero 1,792 KiB origin sample would instead contribute 35 MB less. The existing Linux raw fallback can include launcher high-water, so adding it is conservative and can duplicate launcher residency.
- Worker output adds its own image peak to native helper usage; parent metrics then add that aggregate to the parent image peak. The raw column on the Bun-worker path contains the reaped Bun worker, not that worker's separately summed native helpers. Thus raw below recorded is not, by itself, a physical-memory verdict.

This trace identifies an observed source of combined-RSS variation. It does not retrospectively prove which component caused the original 103-126 MB failures, which were not traced, and does not waive them. No resource accounting, policy, sanitizer or gate was changed. The complete final-head run inventory is recorded in [PR #197](https://github.com/STAIxBWLB/agent-mem/pull/197) without changing the tested head to insert its results.

The pre-existing stage diagnostic anchored an inline notice statement that had moved into `sessionNoticeAndLimit`; another anchor matched both resume and normal context assignment. Only the two diagnostic marker strings were narrowed to the normal brief branch. All timing assertions, samples and deadlines remain. At `03237db8db73`, cold known-work context completed in 67.31 ms and full-foreign context in 68.93 ms, both below 140 ms. The workflow does run this diagnostic, but its `singleAttemptTiming` failures are advisory on GitHub Actions, explaining prior green CI despite the broken preload. Local dgx02 now executes and passes the actual diagnostic.

## Task 77: single iterator ordered by the complete score

Review found two introduced library-search defects: repeated OFFSET queries re-sorted the match set when too few sessions existed, and raw event-weighted ordering could stop before reading a better recent row. The grouped capture path now executes one ordered statement, using the shared final-score SQL recipe (BM25, capture tier, recency and event weight). It keeps the first row of each valid session and stops at the requested number of groups. Missing/invalid hashes remain independent. The legacy unweighted baseline query remains `ORDER BY rank LIMIT`; it still determines the curated cohort and capture slots.

Two new regressions were copied onto the old `ef9d75a` production source and run there, then on corrected source at `f7fced9`:

- Thirty-one old Stop rows, a current tool row, and another old Stop row force the current row outside the former 32-row weighted prefix. Old code selected id 1 instead of current id 32; fixed capture and library search select id 32. The library case explicitly retains 90 days so the 60-day-old rows remain candidates.
- A transaction seeds 10,000 same-session matches before the timed query. Old query time was 3,310.86 ms and failed the 1,000 ms bound. The fixed query passes the bound; its whole test, including setup and seeding, took 161.35 ms. This synthetic fixture checks the repeated-sort regression, not real-corpus throughput or an adoption speedup.

Typecheck, boundary and the corrected focused suite passed: 21 tests, zero failures. Neither timing bounds nor legacy score oracles were weakened.

The complete public S/M runs were renewed at `5d4ce38b9622f9561a38ad718d7d540055d4800b` against the same `15a3dc9` baseline, unchanged harness and datasets. Both completed 500 questions with zero failures and passed all 42 strict no-loss comparisons per set. S metrics are identical. In M, MCP is unchanged; library overall session all@10 falls by 0.00212766 and ndcg_any@10 by 0.00047874. Knowledge-update all@10 falls by 0.01388889 and ndcg_any@10 by 0.00312513. These changes remain within the existing overall 0.005/per-type 0.02 tolerances; all guardrails pass. The adjacent JSON retains the new aggregates. This renewed measurement supersedes the earlier invariant library result for the corrected implementation.

Raw renewed reports use `5d4ce38-` and regression logs `p2-old-regressions.log` / `p2-new-regressions.log` in the same remote artifact directory. Final-head standard/resource checks and the complete R2 outcome inventory are recorded in PR #197 without committing after the tested head.
