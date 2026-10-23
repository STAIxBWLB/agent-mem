# P3 hook budget receipt, 2026-10-23

Status at review: **R2 failed on Linux at `9b0bcae`**. Ubuntu run [39871679397](https://github.com/STAIxBWLB/agent-mem/actions/runs/39871679397) measured SessionStart main+helper peak RSS 106.58 MB, exceeding 100 MB. macOS CI also found capture loss before append on deadline. The historical local Mac table below is not cross-OS acceptance. Replacement evidence follows.

## Rework measurements

Runtime source: `dd249e234835dda500e83b7f12eeab2b966c47b1`, Bun 1.4.2. The parent now loads leaf metrics/normalization modules and publishes screened normalized capture before its optional fixed `--smol` helper. The helper has its own deadline and a pre-resolution scope binding. Timeout retention, replay-after-timeout, commit-before-ack dedupe, full-tier recovery and scope drift have fixture coverage. The expired-deadline regression fails against the former `9b0bcae` hook implementation (zero retained records versus one), then passes with the rework. PostToolUseFailure uses `error` before response fields.

Measurements run the actual executable under empty synthetic HOME/AMEM_HOME/AGENTHUB_HOME. Linux uses the workspace remote-dev container, not a GitHub runner; no provider account, model call or real transcript is involved. Both platforms use the unchanged 150 ms p95 and 100 MB summed main/helper peak limits.

| Platform | Path | Runs | Wall p95 (ms) | Wall max (ms) | Peak RSS (MB) |
| --- | --- | ---: | ---: | ---: | ---: |
| macOS | Plain capture | 40 | 131.87 | 140.84 | 87.70 |
| macOS | Contended capture | 15 | 120.31 | 120.31 | 82.16 |
| macOS | SessionStart, known work | 20 | 129.75 | 130.93 | 85.00 |
| macOS | Drain | 1 | 117.72 | 117.72 | 81.81 |
| Linux container | Plain capture | 40 | 71.07 | 72.91 | 75.25 |
| Linux container | Contended capture | 15 | 68.72 | 68.72 | 77.00 |
| Linux container | SessionStart, known work | 20 | 97.08 | 97.64 | 84.00 |
| Linux container | Drain | 1 | 76.72 | 76.72 | 77.00 |

Both recorded runs passed R1/R2: 76 executable calls, 76 observed helpers and zero remaining owned processes/groups per platform. All 20 SessionStart contexts in each recorded run contained the known work marker; the contended capture rows drained without loss. Full isolated gates passed: macOS 608 pass/0 fail; Linux 603 pass/0 fail/5 OS-specific skips; both boundary checks covered 42 source files, typecheck was clean and npm pack listed 48 files.

One earlier macOS post-suite measurement returned context without the known work marker and failed its existing strict assertion. That attempt did not record the context or cause, so no cause is claimed. The diagnostic now includes this synthetic fixture's bounded context and timing if it recurs; assertions and budgets are unchanged. The next diagnostic run is the macOS table above. A passing retry does not prove this intermittent missing-context leg eliminated. New-head GitHub CI remains pending reviewer readback.

Ingest also advances a durable discard cursor through records larger than its read window, counts the rejected physical record once and resumes at its actual newline. The 5 MiB record regression, unterminated-tail growth, broader-cutoff reset and old-cursor migration are covered. `ingest --help` is handled before intake; its regression fails on the former code's cwd access and passes without a memory/cursor write. The MCP/hook/ingest write allowlist remains explicit in AGENTS.md.

Real Claude Code plugin installation and native timeout semantics, account-backed review turns and real oversized Codex image rollouts remain unverified. A hook cannot guarantee context on an exhausted deadline. Pending capture is local, bounded and unresolved until project/scope replay; it is never brief evidence. Power-loss durability and historical Git config outside the documented stamp are not established.

## Historical macOS measurement

Production source: `bde83cae3a4c022a2b4bca2a6efd52cf0391d66f` (agent-mem#13 P3), rebased on R7 main `1752496`. Bun 1.4.2, macOS. Synthetic project, HOME, memory and hub directories only; no provider account, real transcript, live plugin installation, model or network call.

`bun scripts/measure-hooks-budget.ts` runs the actual `bin/amem.js hook` executable, including startup, screening, git identity, the owned helper, SQLite/spool work, cleanup and the production metrics sample. The fixture has no remote. A test-only preload records each fixed helper PID and process group without changing its work; this observation overhead counts in wall time. RSS is the larger of the CLI high-water value and the sum of main/helper high-water values. The fixture checks known work context, coverage, the byte bound and absence of native control directives.

| Path | Runs | Wall p95 (ms) | Wall max (ms) | Peak RSS (MB) |
| --- | ---: | ---: | ---: | ---: |
| Plain capture | 40 | 112.05 | 119.62 | 81.05 |
| Contended capture, spool and exit | 15 | 106.07 | 106.07 | 75.53 |
| SessionStart with known work | 20 | 116.16 | 120.11 | 82.66 |
| Uncontended drain | 1 | 94.52 | 94.52 | 74.63 |

The historical local macOS R2 run passed: every group p95 below 150 ms and peak below 100 MB. All 20 SessionStart calls returned the known work marker. Contended rows replayed without loss. R1 passed: 76 invocations, 76 observed helpers, zero remaining owned processes/groups. Separate process regressions first demonstrated raw argv exposure and a surviving owned native descendant, then passed with fixed argv/bounded stdin and owned-group teardown. The controlled timeout uses a synthetic helper preload and `/bin/sleep`, never a provider or an unrelated PID.

The hook has a hard parent deadline. Before starting another brief store it reserves cleanup time; later sections can be unavailable while screened work remains. A cold work history can still exhaust the deadline and skip context. This receipt does not establish complete-history capture, account-backed native interoperability, P5 cutover or P6 live-week acceptance.

The earlier P1 capture-like and P2 MCP budgets are separate measurements. New-head Ubuntu/macOS CI is not yet observed at this re-submission.

AC1: packaged seven-event plugin and actual executable capture; project-bound SessionStart prioritization, screening, coverage and caps. AC2: fixture Codex/Kimi/Pi incremental imports, durable cursors, replay dedupe, broadened-since backfill and bounded fair discovery. AC3: runtime and PATH tripwires with positive controls, including the actual helper; no attempts on hook, ingest or direct capture paths. Tests use synthetic data only.
