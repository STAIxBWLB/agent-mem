# Hook-spool pressure receipt, 2026-11-02

- Runtime source commit: `03f913e926240d1d9b1f80643934596258812257`.
- Environment: dgx02 Linux container, Bun 1.4.2, `remote_dev.py verify`.
- Native handler budget: 140 ms. R2: wall p95 below 150 ms and peak below 100 MB, unchanged.
- RSS coverage: owned Bun/supervisor images; descendant RSS is not measured. Raw launcher RSS remains diagnostic on Linux.
- These are synthetic fixture measurements, without live or parked memory access. They are not native macOS evidence.

## Full-spool workload

Each invocation starts with a newly seeded pre-quota backlog. There are 40 physical samples per group, no retries or discarded samples. The script checks admission, counted eviction and unchanged global caps for every invocation.

| Group | Samples | Wall p95 (ms) | Peak RSS (MB) |
| --- | ---: | ---: | ---: |
| 256 active foreign native records | 40 | 85.56 | 77.00 |
| 256 active + 32 reserved foreign native records | 40 | 89.09 | 75.25 |
| SessionStart, both foreign tiers full | 40 | 68.29 | 44.61 |

All 120 complete raw samples, including RSS accounting and retirement receipts, are in [the JSON receipt](hook-spool-r2-2026-11-02.json). Bun 1.4.2 emitted a partial prefix before the complete awaited JSON in this run; the complete report was recovered without dropping a sample. The reporter now uses small atomic writes. The earlier `8225fd0` attempt had only a truncated aggregate; its numeric group verdicts are not used as the complete-sample receipt.

## Existing budgets

`measure-hooks-budget.ts` passed all original groups with unchanged sample counts, R1 checks, thresholds and contention losslessness. Consecutive SessionStart quota retirements are included in explicit recorded + pending + counted-loss conservation, rather than mistaken for missing metrics or silent capture success.

The unchanged `measure-transcript-budget.ts` passed 40 logical runs each of Stop, SessionEnd and the 100-title StopBurst. Every accepted summary remained available behind the committed cursor.

| Transcript group | Physical invocations | Wall p95 (ms) | Peak RSS (MB) |
| --- | ---: | ---: | ---: |
| Stop | 40 | 96.19 | 82.22 |
| SessionEnd | 40 | 92.84 | 80.50 |
| StopBurst, including bounded follow-ups | 422 | 114.53 | 85.75 |

The pre-protection `8225fd0` attempt failed the original StopBurst progress assertion when quota eviction removed summaries behind an advanced cursor. That failure was retained; the production fix protects same-cwd summaries and backpressures new summaries. The progress assertion was not changed.

## Compatibility and ceiling

- The device-only fixture holds inode and birth time fixed, changes `st_dev`, and proves stable-scope replay. Its device-inclusive negative control fails replay.
- Published 0.18.0 and separately packed 0.19.0 writers replay through the same-boot legacy scope fallback. Older readers leave new stable-scope rows for the new reader; an unknown prior device number is never guessed.
- A cap of summaries from four or more orphaned cwds can still refuse capture when the 32-file/256 KiB inspection bound cannot prove native absence. Doctor reports full/partial inventory and known native/summary counts. A derived classification cache is the upgrade; supported off-hook replay is follow-up work.
