# P6 SQL selection results

Issue [agent-hub #412](https://github.com/STAIxBWLB/agent-hub/issues/412), task #93. One performance mechanism: select full note rows with SQL before materializing their Views. Public store APIs, IDs, schema, segments and graph behavior stay unchanged. No revision cache, new derived table or index was added.

## Receipts and protocol

- Baseline result committed at `decfca6`, before editing store.ts; measured source `f322b197fb261a1082db1bef933fa063a50cd271`.
- After measured source `d60c147dbfde89e677c094a7d977cf8e1a9ce181`.
- Same harness SHA-256: `2244884aa023e976c3e054bfd24f20a064522326a842ca6dae9af0d7b28e019a`.
- Before source SHA-256: `f72e66d5f838fc5239acb618534648be69059cf173056d48e988086879e90b6b`.
- After source SHA-256: `7fe449598926d7b3c0613314be531acebbf3f77e1bdf33fb049ab383f779bf37`.
- [Before JSON](p6-before.json), SHA-256 `5495db48b953b91178405cd1b4d14ec63f8dce594c4502950b129d2153050c30`.
- [After JSON](p6-after.json), SHA-256 `3ea963748e58b6ac95841c0b2576eeccd714784f636ae4c8be8b60c9a88188ed`.
- The requested sizes/repeats, environment, every fixture digest and all per-repeat result counts/digests match across runs. Every operation has ten samples at every N; no early-stop exemption was used.
- Portable Linux remote runner, Bun 1.4.2, Intel Xeon Platinum 8480CL host. Container limit: 16 CPU / 32 GiB; host-visible hardware counts in JSON are not the container allocation. One sequential Bun process. Full workload and cache caveats: [protocol](README.md).

## Review commit separation

The original measured implementation `d60c147` was subsequently separated for review without changing its final source, tests or harness. The performance mechanism is `71d2c8d`, the read-snapshot consistency fix and its promotion regression are `67c7633`, and the privacy header-total fix and its regression are `67828cf`. The latter two are correctness/privacy fixes required by their regressions, not additional performance mechanisms.

The frozen after JSON retains `d60c147` as the actual measured source commit. The final source tree at `67828cf` is byte-identical, with Git tree `74837d68f1823180992d717d6159b93b4611758f`; the test tree is also unchanged (`409d7b9e38c1882d612e4d6f9eb5c91c165a6ba3`). No benchmark rerun or changed measurement provenance is claimed by this history reorganization. Both fix regressions were rechecked red on their respective parents and green with the fix; the final focused run passed all ten cases.

## Before and after

All values are milliseconds, p50 / p95. With ten samples, nearest-rank p95 equals the observed maximum, which is also retained separately in each JSON result. These are synthetic workload distributions, not confidence intervals or a production SLO.

| Fixture notes | Operation | Before p50 / p95 | After p50 / p95 | p95 change |
| --- | --- | --- | --- | --- |
| 2,000 | cold_open | 34.90 / 44.79 | 32.94 / 45.28 | +1.1% |
| 2,000 | warm_open | 5.48 / 5.97 | 3.50 / 4.47 | -25.1% |
| 2,000 | write | 6.00 / 7.29 | 3.46 / 4.60 | -37.0% |
| 2,000 | read | 7.63 / 8.98 | 3.61 / 4.78 | -46.8% |
| 2,000 | search | 7.46 / 9.57 | 4.02 / 5.67 | -40.8% |
| 2,000 | fanout_graph_2 | 8.76 / 10.58 | 4.66 / 12.03 | +13.7% |
| 20,000 | cold_open | 390.95 / 418.30 | 354.04 / 366.78 | -12.3% |
| 20,000 | warm_open | 60.13 / 71.64 | 35.37 / 39.77 | -44.5% |
| 20,000 | write | 59.83 / 62.03 | 34.35 / 37.60 | -39.4% |
| 20,000 | read | 80.57 / 83.40 | 43.06 / 51.71 | -38.0% |
| 20,000 | search | 82.00 / 88.34 | 52.68 / 56.44 | -36.1% |
| 20,000 | fanout_graph_2 | 87.12 / 92.27 | 50.52 / 54.15 | -41.3% |
| 200,000 | cold_open | 5518.75 / 5710.72 | 4977.66 / 5293.33 | -7.3% |
| 200,000 | warm_open | 615.55 / 659.55 | 385.65 / 422.94 | -35.9% |
| 200,000 | write | 618.75 / 636.24 | 399.75 / 436.20 | -31.4% |
| 200,000 | read | 884.93 / 945.15 | 505.84 / 520.62 | -44.9% |
| 200,000 | search | 912.29 / 957.00 | 564.13 / 582.12 | -39.2% |
| 200,000 | fanout_graph_2 | 899.95 / 979.35 | 579.29 / 614.85 | -37.2% |

At 200K, read p95 fell 44.9% and search p95 fell 39.2%, meeting the baseline-derived large-store target. Graph code remains in memory; it benefits from the narrower list it consumes. At 2K, cold p95 increased 0.49 ms (1.1%) and graph p95 increased 1.45 ms (13.7%), while both medians fell. Those regressions are retained; ten observations cannot establish their cause or rule out environmental noise. The P0 E9 single-run numbers used a different fixture and machines and are not a direct speedup comparison.

## Mechanism and correctness boundaries

Lifecycle metadata still folds globally using the existing expiry, promotion, forgetting and supersession rules. SQL applies project/shared visibility, effective tier, kind, peer, machine, derived expiry and superseded-ID filters before fetching full bodies and parsing their about JSON. Pruning requests only expired candidate Views. There is no SQL LIMIT; Unicode query matching, Date parsing, locale ordering and JavaScript slice behavior remain unchanged, so a host can screen all matching rows before its caps and visible counts.

Metadata, operations and full candidate rows share one deferred SQLite read snapshot. A red-first second-handle promotion test demonstrated why this is necessary: without the snapshot, the selected set could contain both an old source and a newly indexed promoted copy. This read consistency protection does not make append-and-promotion atomic across writers; C01-C03 remain declared ceilings.

The command wrapper's project-wide long/short header totals now apply the injected readable policy before counting. Its project-wide scope and the existing separate query-specific withheld indicator remain intact. A red-first test demonstrated the previously unscreened aggregate totals. No privacy policy or new read hook was added to the package.

Retained/new regressions cover a fixed-seed old-selection oracle across filters and lifecycle operations, expired/forgotten/superseded/promoted ancestry, literal Unicode and wildcard-like query text, shuffled segments, partial UTF-8 tails, every derived table equal to rebuild, screening before caps/counts and concurrent promotion between projections. The goldens remain retained.

## Residual cost and next proposal

After p50 read still grows from 43.06 ms at 20K to 505.84 ms at 200K (11.75x); search grows from 52.68 to 564.13 ms (10.71x) for 10x entries. These repeated-read distributions and the retained global metadata fold support a separate revision-cache experiment for the C07-style residual scan. Proposed next contract: define log/index revision invalidation, clock-driven expiry and cross-process/rebuild cases first, then measure the same workloads with adversarial invalidation tests. No cache is implemented or claimed here. The fixture has notes but no settlement/supersession operations; dense lifecycle reconciliation performance is unmeasured and should be included in that follow-up. Generic get/promotion reconciliation retain their unfiltered view path. Full prefix hashing and the other C01-C03 mechanisms are unchanged.

## Verification

- `bun x tsc --noEmit`: exit 0.
- `bun scripts/check-boundary.ts`: `boundary: OK (11 source files)`.
- `bun test --timeout 20000`: 95 pass, 5 skip, 0 fail; 100 tests across 10 files, 46.65 s. Five skips are zsh/fish completion checks because those shells are unavailable in the Linux runner.
- `npm pack --dry-run`: exit 0, 15 intended files under LICENSE/README/package.json/bin/src; benchmark data and tests are not shipped.
- Both benchmark runs exit 0. No real memory home, model, sync or live-account leg was used.
