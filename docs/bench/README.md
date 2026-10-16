# P6 synthetic benchmark protocol

This harness measures portable memory operations using synthetic data only. It never opens the person's memory home, reads hub state, invokes a model, syncs or accesses a network. Each invocation creates a temporary parent home, supplies it explicitly to every `MemoryStore`, and removes it on completion. Output contains no host name or temporary/user path.

Run the unchanged harness before and after a storage change:

```sh
bun scripts/bench.ts > before.json
# After the implementation change, using the same harness:
bun scripts/bench.ts > after.json
```

The default sizes are 2,000, 20,000 and 200,000 notes, with ten repeats per operation. `--sizes 2000,20000` selects a subset for a preliminary run; it does not substitute for all three final workloads. `--repeats N` accepts at least ten. For the 200,000-note cold-open series only, the harness may stop early once the series has consumed over ten minutes; its actual sample count and explicit stop reason remain in JSON. An operation already running is allowed to finish.

Record resource admission and any deferred work alongside the report. This repository has one heavy-job slot across its worktrees. A preliminary run or a deferred full run is not full benchmark evidence.

## Workload

Rows are generated as valid, deterministic content-addressed JSONL in batches of 1,000, outside every timed interval. This avoids timing 200,000 individual note writes while constructing the fixture.

- Five synthetic project keys; the measured project is `bench/project-1`.
- One fixed synthetic machine identity and three author peers.
- Every tenth row is shared; all others are project-private. Shared rows belong to project 0, so the measured project exercises cross-project shared visibility.
- Every fourth row is short-term, with a fixed future expiry; the remainder are long-term. All four note kinds cycle independently of the short/long split.
- Every thirteenth row contains both search terms, `needle cohort`.
- Every row has one of 100 group paths; every twentieth row also targets one fanout path.
- Timestamps, note text, IDs and the fixture's long/local segment digests are deterministic for each size.
- A fixed clock and an injected skip screen prevent automatic promotion from changing the fixture.

## Timed operations

| Operation | Timed region | Validation outside timing |
| --- | --- | --- |
| `cold_open` | Construct a store with no index files | Exactly N notes indexed; close afterward |
| `warm_open` | Construct a store with an existing index | Exactly N notes indexed; close afterward |
| `write` | Append one short-term note and its internal refresh | Appended note is readable with exact expected text |
| `read` | List the measured project, long tier, limit 50 | Exact expected nonzero count |
| `search` | List the measured project matching both query words, limit 50 | Exact expected nonzero count |
| `fanout_graph_2` | Two-hop traversal from the fanout path, cap 200 nodes | More than ten nodes, nonzero edges and no dangling endpoints |

Writes use an isolated sixth project and no fanout path. They grow the store by one note per repeat but do not alter the read/search/graph result cohorts. Each non-write operation must produce the same result digest across repeats. Digests and counts allow independent before/after comparison; a changed result is a correctness concern before performance is compared.

Fixture generation, index deletion, validation and store close are excluded from operation timers. Warm-open index setup is also excluded. `cold_open` means the derived index is absent; it does not mean the operating system page cache is cold. The harness does not flush OS caches. Repeats share one process, so JIT and page caches can warm across samples and operations.

## Receipt

JSON includes every sample in milliseconds, result counts/digests, nearest-rank p50/p95/max, actual repeats and early-stop reasons. A remote mirror without `.git` accepts `AMEM_BENCH_SOURCE_COMMIT` from the caller; the receipt labels its provenance and independently hashes the actual source tree. It also records source commit, a digest of sorted source paths/content hashes, the harness SHA-256, CPU model/logical core count, architecture, RAM bytes, OS/release and Bun version. CPU frequency, thermal state and other processes remain uncontrolled environmental factors.

The benchmark does not assert a performance target, replace privacy/lifecycle tests, measure real user data, or prove live multi-machine sync. Before/after reports must retain the same harness SHA and fixture digests; source SHA should change only with the intended implementation changes. Interactive and account-dependent receipts remain separate.

## P6 baseline and target

`p6-before.json` records the untouched `f322b197fb261a1082db1bef933fa063a50cd271` source, with all three sizes and ten samples for every operation. It was measured through the workspace remote development runner, with a 16-CPU and 32-GiB container limit. The JSON hardware fields describe the host-visible CPU and RAM, not the container allocation. The benchmark is one sequential Bun process, with no worker pool.

At 200,000 notes, baseline read p50/p95 is 884.93/945.15 ms and search is 912.29/957.00 ms. The SQL-selection target is to reduce those observed large-store distributions while preserving exact results; all smaller-store, open, write and graph distributions will also be reported, including regressions. Ten samples make nearest-rank p95 the observed maximum; these are workload measurements, not a production SLO or a statistical confidence claim. No revision cache or lifecycle/concurrency mechanism is included in this step.
