# Hook RSS source accounting

Issue #198 keeps the existing 150 ms p95 / 100 MB peak limits, handler and cleanup deadlines, sample counts, timeout fixtures and retry helpers.

## What is counted

The existing harness defines production RSS as a conservative sum of counted exec-image peaks: the hook, its Bun worker when launched, and overlapping native supervisor images. The metric now labels that scope as `owned-images`. External Git/ps command descendants are not independently measured; raw reaped values remain diagnostics. This receipt does not establish a whole-process-tree RSS bound.

Each sample carries `rssSource` and counts for `VmHWM`, `VmPeak-bound`, platform rusage, raw fallback and unavailable telemetry. On Linux, a known production image reading is the gate; outer CLI wait4 remains raw diagnostic because resource usage survives exec. Missing or fallback-only provenance fails the measurement even when its numeric RSS is small. Darwin retains its platform-rusage accounting.

[Linux getrusage documentation](https://man7.org/linux/man-pages/man2/getrusage.2.html) describes preserved exec resource metrics and the largest-child meaning of child maxRSS. [The proc status documentation](https://man7.org/linux/man-pages/man5/proc_pid_status.5.html) defines VmPeak as peak virtual size and marks VmHWM inaccurate. The live dev-image shell reproduced VmPeak 2672 KiB with VmHWM/VmRSS 0 while still running. RSS cannot exceed its process image's peak virtual size, so a positive VmPeak supplies a labeled conservative upper bound when VmHWM is zero. A missing VmHWM and VmPeak remains unknown; a large virtual bound still exceeds the unchanged gate.

Native supervisors emit bounded numeric terminal receipts before watchdog teardown, using shell builtins. Failed telemetry writes cannot terminate the reaper through SIGPIPE. Bun workers send bounded numeric intent/start/completion frames inside the existing 8 KiB channel; the parent samples still-live images before kill and retains valid snapshots across later empty zombie reads. No model, network, resident process or new runtime dependency is added.

## Consecutive series

The complete numeric receipt is [hook-rss-198.json](hook-rss-198.json). Every physical attempt remains in the raw log named by each row under `/home/dev/tmp/amem-198/` on the dgx02 dev-container home volume.

| Runtime head | Main base | Suites | Outcome |
|---|---|---:|---|
| `3fdde86` | `392b317` | 1 prototype | pass |
| `bb2bfff` | `dd97408` | 10 fixed consecutive | 6 pass, 4 unknown-provenance failures |
| `b8dbebe` | `dd97408` | 10 fixed consecutive | 10 pass |
| `8a506bf` | `6792bbd` (#208) | 10 fixed consecutive, including jcode | 10 pass |

The four failures were the forced PreToolUse worker-timeout path. Repeated teardown replaced a valid pre-kill snapshot with an empty read after exit. The monotonic snapshot correction has a deterministic regression and changes no timeout or retry. The second series was one predeclared ten-run batch after that root-cause change, retaining the first series in full.

Both ten-pass series passed R1 and R2, with zero retained processes. Every accepted sample had known provenance; no raw-fallback or unavailable sample was accepted. The final integrated series at `8a506bf` includes 40 jcode invocations in every suite. Ranges below span that integrated series.

| Workload | Wall p95 range, ms | Maximum RSS, MB |
|---|---:|---:|
| plain | 75.63-82.75 | 77.86 |
| spoolAndExit | 72.93-80.04 | 73.50 |
| sessionStart | 63.86-68.20 | 44.61 |
| sessionStartRepoLog | 65.62-68.82 | 46.36 |
| drain | 81.44-88.04 | 71.75 |
| jcode | 74.99-83.88 | 71.75 |

These are exact main-based candidate executions. Literal post-merge-main confirmation is a separate reviewer gate. After the earlier series, worker telemetry-write failures gained an explicit invalidity marker and a fault-injection regression, and the non-Linux worker rusage floor retained its prior aggregation formula. Those changes and #208's source propagation are included in the integrated series.

## Checks and integration

Typecheck, boundary and 22 focused resource/native/worker tests passed at `b8dbebe`. The early terminal-receipt prototype exposed two focused failures (parent-death reaping and zero-HWM receipt handling); the SIGPIPE and VmPeak-bound corrections passed their focused checks before the consecutive series.

At `35b1224`, the full suite passed 2,381 tests with 7 skipped, and package dry-run passed. At `4d06708`, the full suite passed 2,382 tests with 7 skipped, package dry-run and the source-attributed R2 harness passed. The integrated runtime `8a506bf` passed typecheck, boundary, 29 focused tests and the ten-suite series above. Final delivery-head standard gates are recorded in the PR separately.

PR #208 is merged in main `6792bbd`; its jcode branch now propagates RSS provenance. Task 81's worktree remains held and unchanged. A private capture-only preview (`b9e9b6b`) composed that task's scanner with corrected accounting and #207's format-floor guards: 40 normal Stop calls passed at p95 96.00 ms / peak 80.50 MB; 40 SessionEnd calls at 95.29 ms / 78.75 MB; 40 cold-home 100-title bursts at 119.49 ms / 75.25 MB. All 120 samples used the source-validation gate. This preview does not establish final #201 AC4 or its private replay. The [accounting adapter patch](hook-rss-198-transcript.patch) is retained for the task's existing harness.
