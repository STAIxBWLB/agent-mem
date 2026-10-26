# Hook drain investigation (#92)

Measured on macOS arm64 with Bun 1.4.3 on 2026-10-26, from main f54158d. Fixtures use a fresh Git repository, private HOME and memory home, fake public events and real owned hook executables. No account, user memory or model is accessed. Native handler 140 ms, external wall 150 ms, RSS 100 MiB and correctness retry rules are unchanged.

# Historical evidence

The [PR #91 macOS failure](https://github.com/STAIxBWLB/agent-mem/actions/runs/40283746026/job/121442527119) at 19d515f actually made four drain invocations, not three. They returned in 127.345, 124.556, 126.457 and 123.899 ms, individually passing, before the group failed with observed=0/expected=55. All stall and zero-worker deferral counters were zero. Before/after CPU was 9.479/9.688 ms, spawn 19.033/18.449 ms, and raw I/O triples were [14.333334, 6.748416, 5.722292] / [10.422750, 8.399709, 6.306500] ms. Both maxima exceeded the existing Darwin 5.58 ms threshold. A correctness failure correctly received no probe-gated re-measure.

The [same-head rerun](https://github.com/STAIxBWLB/agent-mem/actions/runs/40283746026/job/121448343383) replayed all 55 workload events with one drain invocation, still classifying the runner as slow. The original failure did not retain worker stages or spool contents, so those logs alone cannot prove its unique cause. It is not classified as a harmless flake.

# Reproduced mechanism and retained state

An unmodified macOS control passed with one 58.29 ms drain. To exercise the slow cold path, an isolated PATH Git wrapper delayed only `remote get-url origin` and the combined `rev-parse --path-format=absolute ...` read. A test-only Bun loader recorded worker boot, identity start/end and drain start/end into private JSONL. Its overhead remains included in hook wall/RSS observations. The wrapper delegates to the verified real Git; no returned identity is fabricated.

| Fixture | Before worker prefetch | After worker prefetch |
|---|---|---|
| 20 ms added to each native read | 0/55 after four drains (120.27, 118.57, 120.42, 118.84 ms) | 55/55 after one drain (60.55 ms) |
| 40 ms added to each native read | 0/55 after four drains | 0/55 after four drains; deadline ceiling remains |

At the 20 ms failure, all 59 accepted events (55 workload events plus four barrier events) remained in owned pending receipts, all workers were reaped, and the expected capture shard still contained only its original seed. The trace had 59 identity starts, zero identity completions and zero drain starts; no identity cache had been published. The pending records, receipt names/modes, worker observations and stage trace were retained privately before cleanup. This establishes pre-drain starvation in this reproduction, rather than partial row loss or a worker still running after the harness checked.

The same 40 ms failure's retained receipts were then replayed through the existing functional hook transport, which waits for completion with its existing 2 s test-only deadline. Two completions recovered 32 then all 55 workload events in the same project, without duplicates; all 59 original receipt IDs were present exactly once and pending became empty. This recovery is diagnostic evidence, not an R2 sample or a relaxed production gate.

# Change and regression

The capture worker now enables the existing exact shared resolver's origin/metadata prefetch, as the SessionStart parent path already does. Previously both native launches were sequential. If cold identity resolution exhausted the worker's absolute deadline before verification/publication, no binding was cached and every subsequent invocation repeated the same cold path. Drain had not started. The change overlaps those reads; the same resolver still decides identity, checks status and scope, cancels unused metadata and reaps owned native groups. Cache hits start no native reads. No spool format, receipt, selection or deadline changes.

The regression stages 55 real pending capture records, then runs the real capture worker against a mutual Git-read barrier. Origin cannot complete until metadata starts, so serial execution fails deterministically without comparing elapsed time. The test failed on the old worker (metadata never started), then passed with prefetch. It verifies all 55 rows exactly once after two bounded batches and exactly one origin/metadata pair across cache reuse. The existing functional transport isolates this correctness test from the separate unchanged native timing gates.

`measure-hooks-budget.ts` also emits a failure-only `hook-drain-state` inventory before throwing: pending invocation IDs and scope-known status, capture spool receipts, identity-cache files, and numeric owned-worker/precheck evidence. Collection occurs after measured samples, never retries correctness, and does not change a failing verdict.

The ceiling remains: identity must fit one native hook deadline. The 40 ms injected case still defers durably even after prefetch. Arbitrarily slow schedules are not guaranteed to progress; revalidated durable identity progress would be a separate upgrade. The reproduced mechanism is consistent with the CI symptom, but the missing historical state prevents claiming it is the only possible cause of that old run.

# Separate Ubuntu timing miss

On main e1cb2ff, [run 40278699670](https://github.com/STAIxBWLB/agent-mem/actions/runs/40278699670/job/121426950583) missed only `evictionAfterShrink`: p95 252.75 then 194.50 ms against 150 ms. Append/spool p95s were 85.73/73.42 then 90.44/72.70 ms; RSS passed and each attempt wrote 66 metrics.

| Attempt | Before raw I/O triple (ms) | After raw I/O triple (ms) | #80 classification |
|---|---|---|---|
| 1 | 14.563146, 2.519317, 2.850136 | 2.887856, 2.346380, 2.489863 | slow, before max > 5.56 |
| 2 | 2.309826, 2.248826, 2.263969 | 5.764373, 2.469924, 3.028560 | slow, after max > 5.56 |

The existing max-sample rule caught both intermittent spikes; the second wall miss correctly exhausted the single re-measure allowance. The [same-head rerun](https://github.com/STAIxBWLB/agent-mem/actions/runs/40278699670/job/121448350541) passed: eviction p95 60 ms, slow=false. These receipts correlate with transient runner slowness; they do not prove that the probe spike caused the workload miss. No budget or probe change is made here.
