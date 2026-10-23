# P3 hook budget receipt, 2026-10-23

Status: **macOS R2 remains open**. At `570f29c2b3777247c7ecb14884f3e0d681db03bd`, actual [run 39898659447](https://github.com/STAIxBWLB/agent-mem/actions/runs/39898659447) passed Ubuntu, including SessionStart own combined peak 86.09 MB (raw 100.1 MB), p95 88.4 ms and zero R1 leftovers. macOS job 120234875962 failed two unit assertions (full-tier SessionStart replay and plain SessionStart empty JSON) and the unchanged strict budget assertion (empty context, wall 164.05 ms, metric 142.81 ms). The local Mac pass below did not establish runner acceptance. PR #34 remains unmergeable until exact-head CI is green on both OSes and re-review is clean.

## Round 2, full-tier fairness and runner diagnostics

Runtime candidate `b4fa6256899e7c7afc7f460b88c53527c0b50f8c` fixes a separate reproduced starvation bug. With 256 valid pending records from existing project B, project A previously emitted no SessionStart context and retained none of its new events. At capacity, one bounded retirement pass can now move oldest valid foreign-cwd records into private quarantine, preserving their bodies without binding them to A. Healthy admission still retires unresolved records within the same bounds. Repeated capacity refusal after recovery retains its computed brief; the library receipt does not falsely report an unadmitted capture as durably pending. Concurrent publication can still exhaust the finite capture tier; this does not justify discarding a computed context.

The six-event cross-project native regression fails at the old head on the named nonempty-output assertion; it passes with all six events exactly once as a row or pending, no foreign capture in A, and bounded quarantine. A separate repeated-refusal regression is red before the brief-preservation catch and green after it. Existing same-project full-tier assertions are unchanged.

Cold Mac timing is not closed by another local pass. After the unchanged budget step (so the diagnostic cannot warm it), a numeric-only diagnostic step records CLI boot, helper spawn/boot, hardened native identity calls, lease signature and reaping milestones on the real GitHub runner, even after a failed unit step. It never changes the hook deadline or budget assertions and logs no paths, payloads or tokens. A local four-call diagnostic showed helper boot around 21 ms, imports about 7 ms, the two Git identity queries around 9 and 12-16 ms, and the remaining lease/store/context work around 11 ms. These are a lead for actual-runner profiling, not the cause asserted for the runner's 164 ms failure. The runner's cold-path diagnosis and fix remain open. A local native 1.4.2 check of this runtime passed all 20 known-work contexts with p95 114.45 ms, max 117.03 ms and conservative combined peak 84.16 MB; 55 original captures replayed exactly once and R1 found zero leftovers. Those local numbers do not close the runner failure.

A pinned Bun 1.4.2 Mac probe did not reproduce the reported 1.4.3 4.6 MB self figure. Three fresh children measured near-exit self peaks 11,584/11,536/11,584 KiB, parent-observed ps RSS 11,456/11,408/11,456 KiB and reaped wait4 peaks 11,680/11,632/11,680 KiB. A child touching 8 MiB measured self/ps 24,048 KiB and wait4 24,112 KiB. Darwin worker accounting now floors its reported self sample at the reaped wait4 peak. Linux retains the reviewed per-image VmHWM logic and raw diagnostics. The two-image sum excludes native Git descendant peaks (about 7.8 MB in the reviewer's local probe); it is not claimed to be an entire process-tree peak. The independent CLI wait4 floor remains. Whole-tree sampled accounting is a future measurement upgrade, not a reason to raise the current limits.

## Historical round 1, SessionStart priority

Runtime candidate: `71813553414ae564065aaa84142d190840fb7692`. A normally staged SessionStart now leaves its screened capture durably pending and avoids pre-brief CaptureStore loading/draining. Later non-SessionStart invocations replay it; full-tier admission still performs bounded recovery. Optional curated/capture sections need 80 ms remaining; work still needs 10 ms. The 140 ms handler deadline, 150 ms external p95 and 100 MB combined peak criterion are unchanged.

Two new regressions fail on the former runtime: a native SessionStart whose optional capture import throws must still emit known work, and a brief with 70 ms remaining must defer optional stores while preserving work. The native test observes the attempted module load under the old implementation, then verifies eventual exactly-once replay with the fix. Full-tier native recovery now covers both PostToolUse and SessionStart. The backlog fixture checks every staged event is retained exactly once as a row or pending record, then uses up to three production bounded drain passes before its unchanged final exactly-once/pending-clear assertions. It no longer assumes four deadline-bound native calls necessarily acknowledge 65 records. The native budget workload and all its assertions are unchanged.

Actual GitHub Ubuntu job 120192956976 at the previous head:

| Path | Runs | Wall p95 (ms) | Wall max (ms) | Own combined peak RSS (MB) | Raw combined peak RSS (MB) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Plain capture | 40 | 50.92 | 53.22 | 85.66 | 95.49 |
| Contended capture | 15 | 50.80 | 50.80 | 86.53 | 100.61 |
| SessionStart, known work | 20 | 77.94 | 79.95 | 95.45 | 109.97 |
| Drain | 1 | 56.87 | 56.87 | 85.94 | 100.46 |

R1: 76 invocations, 76 helpers, zero leftovers. macOS job 120192956814 passed 629 unit tests with three OS-specific skips, but its strict budget run failed with empty SessionStart output: wall 153.20 ms, metric 138.84 ms, stderr zero bytes. A unit-suite pass did not establish R2.

Native macOS measurement of the new candidate's runtime, Bun 1.4.2, isolated synthetic homes:

| Path | Runs | Wall p95 (ms) | Wall max (ms) | Own combined peak RSS (MB) | Raw combined peak RSS (MB) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Plain capture | 40 | 102.52 | 103.60 | 84.73 | 84.91 |
| Contended capture | 15 | 90.26 | 90.26 | 83.00 | 83.13 |
| SessionStart, known work | 20 | 110.53 | 116.73 | 83.69 | 83.84 |
| Drain | 1 | 86.13 | 86.13 | 82.88 | 83.00 |

All 20 known-work contexts passed, all 55 original captures replayed exactly once, and R1 observed 76 invocations/helpers with zero leftovers. The six-file focused suite passed 57 tests and 1,826 expectations. The frozen runtime full Linux AGENTS gate passed: typecheck clean, `boundary: OK (45 source files)`, 631 pass, five unavailable-shell skips, zero failures, 9,429 expectations across 636 tests/80 files in 137.47 s, and `npm pack --dry-run` listed 51 files. This local Mac result is diagnostic evidence; exact-head GitHub macOS CI remains required.

## Linux peak RSS measurement proof

Linux metrics read their own `/proc/self/status` VmHWM, documented as peak resident set size in the [Linux kernel proc documentation](https://docs.kernel.org/filesystems/proc.html). Conservative rusage fallback remains when proc data is unavailable or malformed. Unknown never becomes zero. Parent/helper peaks are still summed, the independent CLI rusage floor remains, and `rawRssMB`/`rawCombinedPeakRssMB` retain the former measurement alongside it.

`test/hooks-resources.test.ts` proves the distinction causally. A launcher touches 128 MiB before exec; the measured child samples its own peak, touches 16 MiB itself and samples again after release/GC. The new sampler reported before 14,336 KiB, own allocation 32,256 KiB and retained peak 34,048 KiB, while raw rusage remained 145,152 KiB. The child-allocation assertion and a 64 MiB separation assertion both pass. Replacing the sampler with the former `process.resourceUsage().maxRSS` makes the named allocation assertion fail: before/allocation/own/raw all read 145,152 KiB. This rules out a fixed subtraction and proves sensitivity to the child's own allocation. A second regression runs the actual packaged hook through the pressured launcher: production metrics reported own combined 66.5 MB and raw combined 176.75 MB. Both tests pass in the frozen candidate Linux gate.

An earlier independent fork/exec probe held the child's current RSS at 9,175,040 bytes while touching 128 MiB only in its launcher changed raw peak from 12,544 to 146,944 KiB. That reproduction explains the inherited pre-exec high-water; neither the probe nor container measurements replace GitHub acceptance.

The owned worker flushes a complete bounded result before terminating its still-live process group on completion; fatal paths and the self-deadline reap the same group. Pending identity ignores rewritten HEAD/config inodes, binds supported project-deciding configuration, and retires unresolved/removed scopes into bounded private quarantine outside the active cap. Existing red-first quarantine, exactly-once, full-tier, process-reaping and network-tripwire regressions remain required. New-head CI and reviewer verification remain open.

## Historical round 3 verification

Round 2 at `241158559ce08ef60d168d4d212587b3a183869e` also failed on the actual Ubuntu runner: [run 39875883123](https://github.com/STAIxBWLB/agent-mem/actions/runs/39875883123), job 120161255064 measured 107.07 MB SessionStart, 100.87 MB contended capture and 100.66 MB drain (plain capture 96.27 MB). The Linux-container table below did not predict that result and does not establish R2 acceptance. That head did not meet Ubuntu R2; the later actual-runner result above supersedes it.

Round 3 runtime: `68f9e76681e905f22c99df9f525515ee12f1b885`. The published executable and plugin now enter Bun `--smol` directly, with same-PID exec replacement for an explicit non-smol Bun invocation. Process helpers and optional stores load lazily. The budget harness executes the published executable and retains its original process-start clock and 150 ms/100 MB criteria.

Pending identity no longer hashes rewritten HEAD/config inodes. It binds physical directories, canonical HOME and supported project-deciding configuration. Changed, removed or unsupported scopes leave active admission through private bounded quarantine; malformed publications age out. Admission retirement inspects at most 32 bodies/256 KiB per call, and private quarantine has its own capacity. Fatal native Git resolution cannot fall back to a different local project key. Checkout/config rewrites, removed worktrees, full orphan and valid tiers, HOME changes, fatal Git recovery and quarantine trimming have regression coverage.

Capture tests now prove eventual exactly-once replay through real subsequent hooks, allowing the final accepted barrier to remain durably pending. SessionStart reserves 80 ms before capture draining; work admission still needs 10 ms. No deadline or RSS acceptance threshold was raised.

Final isolated AGENTS gate on this runtime passed in the remote Linux container: typecheck clean, `boundary: OK (43 source files)`, 623 pass, 5 OS-specific skips, 0 fail, 8,944 expectations across 628 tests/77 files (134.69 s); `npm pack --dry-run` listed 49 files. The native Mac focused suite passed 51 tests/1,347 expectations, including the strict Git and full-tier recovery cases. A read-only audit of the final safety changes found no additional Important issue.

Native macOS budget measurement, Bun 1.4.2, same runtime commit:

| Path | Runs | Wall p95 (ms) | Wall max (ms) | Combined peak RSS (MB) |
| --- | ---: | ---: | ---: | ---: |
| Plain capture | 40 | 119.41 | 128.58 | 83.33 |
| Contended capture | 15 | 117.20 | 117.20 | 82.42 |
| SessionStart, known work | 20 | 123.57 | 130.47 | 83.67 |
| Drain | 1 | 121.81 | 121.81 | 81.84 |

R1: 76 actual executable invocations, 76 observed helpers and zero remaining owned processes/groups. R2 passed locally with unchanged thresholds. Every known-work SessionStart context passed. All 55 original workload captures replayed exactly once; 56 total invocations were captured and the final 20 SessionStart capture acknowledgements remained durably pending. Pending data was checked separately and never treated as context evidence. No claim of same-invocation capture is made.

**New-head Ubuntu runner R2 and both-platform CI remain unverified at submission.** The workflow runs this unchanged budget check on the real Ubuntu runner; a local/container pass cannot close that review finding. No additional Linux-container budget table is offered as replacement runner evidence.

## Historical round 2 measurements

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

Both historical local/container runs met their measured R1/R2 thresholds, but subsequent Ubuntu CI failed: 76 executable calls, 76 observed helpers and zero remaining owned processes/groups per platform. All 20 SessionStart contexts in each recorded run contained the known work marker; the contended capture rows drained without loss. Full isolated gates passed: macOS 608 pass/0 fail; Linux 603 pass/0 fail/5 OS-specific skips; both boundary checks covered 42 source files, typecheck was clean and npm pack listed 48 files.

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
