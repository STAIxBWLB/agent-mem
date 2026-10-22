# P3 hook budget receipt, 2026-10-23

Production source: `bde83cae3a4c022a2b4bca2a6efd52cf0391d66f` (agent-mem#13 P3), rebased on R7 main `1752496`. Bun 1.4.2, macOS. Synthetic project, HOME, memory and hub directories only; no provider account, real transcript, live plugin installation, model or network call.

`bun scripts/measure-hooks-budget.ts` runs the actual `bin/amem.js hook` executable, including startup, screening, git identity, the owned helper, SQLite/spool work, cleanup and the production metrics sample. The fixture has no remote. A test-only preload records each fixed helper PID and process group without changing its work; this observation overhead counts in wall time. RSS is the larger of the CLI high-water value and the sum of main/helper high-water values. The fixture checks known work context, coverage, the byte bound and absence of native control directives.

| Path | Runs | Wall p95 (ms) | Wall max (ms) | Peak RSS (MB) |
| --- | ---: | ---: | ---: | ---: |
| Plain capture | 40 | 112.05 | 119.62 | 81.05 |
| Contended capture, spool and exit | 15 | 106.07 | 106.07 | 75.53 |
| SessionStart with known work | 20 | 116.16 | 120.11 | 82.66 |
| Uncontended drain | 1 | 94.52 | 94.52 | 74.63 |

R2 passed: every group p95 below 150 ms and peak below 100 MB. All 20 SessionStart calls returned the known work marker. Contended rows replayed without loss. R1 passed: 76 invocations, 76 observed helpers, zero remaining owned processes/groups. Separate process regressions first demonstrated raw argv exposure and a surviving owned native descendant, then passed with fixed argv/bounded stdin and owned-group teardown. The controlled timeout uses a synthetic helper preload and `/bin/sleep`, never a provider or an unrelated PID.

The hook has a hard parent deadline. Before starting another brief store it reserves cleanup time; later sections can be unavailable while screened work remains. A cold work history can still exhaust the deadline and skip context. This receipt does not establish complete-history capture, account-backed native interoperability, P5 cutover or P6 live-week acceptance.

CI runs this same measurement on Ubuntu and macOS. Linux R2 is pending CI at submission, not measured as zero. The earlier P1 capture-like and P2 MCP budgets are separate measurements.

AC1: packaged seven-event plugin and actual executable capture; project-bound SessionStart prioritization, screening, coverage and caps. AC2: fixture Codex/Kimi/Pi incremental imports, durable cursors, replay dedupe, broadened-since backfill and bounded fair discovery. AC3: runtime and PATH tripwires with positive controls, including the actual helper; no attempts on hook, ingest or direct capture paths. Tests use synthetic data only.
