# Capture recall: input text, event weight and session representatives

Issue #196 adds a bounded Claude tool-input line, a fixed 1.25x conversational-event ordering weight, and one capture result per attributed session. It preserves the legacy unweighted non-capture cohort before refilling capture slots. Returned score fields retain their previous meaning. Missing session hashes are independent groups.

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
