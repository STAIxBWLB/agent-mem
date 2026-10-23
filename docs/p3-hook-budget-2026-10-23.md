# P3 hook budget receipt, 2026-10-23

Status: **acceptance remains open**. At `04567d7482875e43c5c15efc15f24d4fb2d09fbd`, actual [run 39944509583](https://github.com/STAIxBWLB/agent-mem/actions/runs/39944509583) passes Ubuntu. macOS passes the actual R1/R2 workload but fails an optional-import marker assertion and the separately instrumented cold-stage diagnostic. Its cold trace reaches parent entry at 33.67 ms, runs origin metadata at 43.41-66.96 and root metadata at 70.15-110.88, then repeats full synchronous identity/cache preparation until cache publication at 166.05 and project completion at 183.66. No known-work output was returned. The earlier full-tier event-retention regressions pass on both OSes at this head; the completed trace does not close cold-context acceptance.

## Cold resolver preparation and optional fault coverage

The completed macOS runner at 04567d74 reports R1 zero leftovers and actual R2 p95 / own peak / raw peak: plain 94.95 ms / 63.89 MB / 63.91 MB; contention 74.27 / 63.52 / 63.53; SessionStart 76.49 / 42.11 / 42.11; drain 78.63 / 63.70 / 63.72. Those passing uninstrumented workload numbers coexist with the failed cold-stage trace; they are not a whole-job pass or a new-head receipt.

Async native reads now prepare binary, cwd/scope and cache validity once. Suspended reads replay only the shared project-key resolver with already-completed Git results. Each subsequent native spawn still rechecks the bound binary revision and deadline. Final completion fences all requested reads, binary, strong validity (including semantic scope), and deadline before publication or returned identity. Unknown strong validity also requires the separate semantic scope check. Standalone synchronous callers use the same prepared closure. The causal regression observes three full preparations in the preceding source and exactly one with two native queries in the new source. New drift tests prove a replaced binary cannot receive the second query and nonsemantic config drift cannot publish a cache; prior parity, scope-change and incomplete-read regressions remain.

The stage observer previously opened/appended its trace synchronously at every mark on the path being timed. It now buffers at most 256 fixed marks in memory and flushes once on process exit. Preload and observation overhead still count, and the cold known-work-before-140-ms assertion is unchanged. The independent actual CLI R1/R2 budget script is unchanged. The new completion-stage marks expose the final binding reads separately from native query time.

The repeated-full-tier missing-capture test previously required its optional import marker even when a native remaining slice correctly skipped that optional branch. It still requires actual native known-work output, and now separately guarantees branch entry in the library invocation using host-only identity and clock ports before requiring the fresh fault marker and bounded known work. Moving the real optional import outside its protective catch fails the native named known-work assertion in a mutation probe. This separates optional-path coverage from native scheduling, without changing the production deadline or library defaults.


Pinned Bun 1.4.2 local macOS validation for the prepared-resolver candidate: typecheck clean; boundary OK (48 source files); 687 pass / 2 Linux-only skips / 0 fail, 12,856 assertions across 689 tests and 88 files (142.29 seconds); npm pack dry-run OK (54 files). Local native R1 observes 76 invocations, 56 Bun workers plus 20 native supervisors, zero leftovers and all 76 invocation captures acknowledged. Local R2 p95 / combined own peak: plain 42.24 ms / 72.61 MB; contention 42.94 / 69.48; SessionStart 50.65 / 46.02; drain 45.43 / 67.70. Cold known-work output is 429 bytes at 71.05 ms; the foreign-full-tier trace returns known work at 90.81 ms. These local numbers do not substitute for the still-required two consecutive green actual runs on both OSes at the new exact head.

## Bounded durable full-tier intake

The next native event is now published before optional replay even when the ordinary tier is full, through a private cwd/scope-bound 32-file/256 KiB `.capacity/` reserve. No project is guessed and no accepted matching backlog is evicted. Reserve replay uses the same stamp, policy, stable receipt and owned inode/claim checks, globally oldest-first with active records. A failed append retains its claim in the source tier. Privacy quarantine remains non-replayable. The finite combined-capacity ceiling and upgrade path are explicit in contracts.md.

The native tests retain numeric failure diagnostics and assert no loss, no duplicates, ordinary/reserve bounds, and exactly-once acknowledgement of all 256 backlog records plus the next event within 24 following invocations. An already-expired full-tier hook proves its next event remains durable without any recovery time; this assertion fails on the preceding hook implementation. A zero-budget drain changes nothing; nine threshold-budget passes drain the 257-record snapshot and another pass adds nothing. Separate leaf tests require progress when 8 ms is available, and preserve current-policy and scope refusals. The late-brief regression uses deterministic host-only identity and clock ports to prove ordering rather than assuming a native cold boot left a recovery slice. Actual CLI budget/reaper tests retain the unchanged 140/150/100 limits.

The earlier standalone CaptureStore contention test has no new production change. Its 25 ms between-file guard is already on main; its latest actual Ubuntu and macOS results pass. Its numeric failure-only diagnostics remain for another recurrence. No causal claim about its one earlier failure is made.


Earlier pinned Bun 1.4.2 local macOS validation at 04567d74 for the capacity-reserve change: typecheck clean; boundary OK (48 source files); 684 pass / 2 Linux-only skips / 0 fail, 12,782 assertions across 686 tests and 88 files (139.83 seconds); npm pack dry-run OK (54 files). The expired-full-tier assertion is red against the preceding hook source and green with reserve admission. The leaf admission regression is red against the preceding spool source. No test requires a same-invocation drain when its allocated slice is below 8 ms.

Local R1: 76 invocations, 56 Bun workers and 20 owned native supervisors, zero leftovers. All 76 invocation captures were acknowledged, including all 55 original workload records; pending acknowledgements were zero. Local R2 p95 / own-combined peak / raw-combined peak: plain 41.51 ms / 73.53 MB / 73.55 MB; contention 39.09 / 68.45 / 68.47; SessionStart 49.51 / 45.95 / 45.95; drain 47.24 / 67.53 / 67.55. The cold trace returns 429 bytes of known work at 67.91 ms, and the foreign-full-tier trace at 81.93 ms. These are local receipts only. Actual runner acceptance still requires two consecutive green runs on both OSes at the new exact head, plus the held review verdict.

## Runner recovery diagnostics

This follow-up changes diagnostics only, leaving the production implementation, original success assertions and 140 ms / 150 ms / 100 MB limits unchanged. The two native full-tier tests install a test-only preload and include numeric stderr records in a failed assertion. A worker inherits that preload explicitly; its numeric records survive a deadline kill. No path, project id, stamp, capture text, native input or exception message is emitted.

Records are numeric arrays, with the first value identifying the stage:

| Code | Remaining values |
| --- | --- |
| 1 | Parent SessionStart entered |
| 2 | Remaining handler milliseconds after initial admission |
| 3 | Remaining milliseconds after project identity |
| 4 | Remaining milliseconds at recovery check; full-tier flag (0/1) |
| 5, 6 | Remaining milliseconds before and after brief |
| 7 | Remaining milliseconds before worker launch |
| 8 | Worker remaining milliseconds; answer flag; answer bytes |
| 10, 11 | Worker remaining milliseconds at input and resolved identity |
| 12 | Worker remaining milliseconds; drained count; blocked count |
| 20 | Remaining milliseconds; stamp present flag; expected stamp match flag |
| 21 | Remaining milliseconds at each drain budget check; drained count; blocked count |
| 22, 23 | Remaining milliseconds before and after append (23 proves lock/write succeeded) |
| 24 | Append/drain failure class: 1 lock/busy, 2 other |
| 25 | Active inventory count; records retired during admission |
| 26 | Scanned records; cwd matches; stamp matches |
| 27 | Reserve inventory count; reserve-admission flag; prior-backlog flag |

Unknown or absent budgets use -1; non-finite numeric observations use -999. These records are evidence for the next runner result, not evidence that recovery succeeded. Direct CaptureStore contention replay has its own numeric diagnostic because it does not call hookWorker and cannot be attributed to the latest worker reserve without further evidence. In the failed runner log the first spooled row was present and only the second was missing. The between-file 25 ms guard first appeared in `995a00bf79d6417999d06bdd21903eda7645031b` and is also present on main; neither capture.ts nor this test changed between 0162265f and 1016db8a. The wrapper reports total drain elapsed time and a 25-minus-elapsed estimate, plus this fixture's known lock state; it does not claim to observe a lock swallowed internally. A budget stop between files is a hypothesis pending the new runner diagnostic, not a verified cause.


The diagnostic-only candidate passed its isolated-HOME native macOS gate on pinned Bun 1.4.2: typecheck clean, boundary OK (48 source files), 675 pass / 2 Linux-only skips / 0 fail, 9,768 assertions across 677 tests and 87 files (138.10 seconds), and npm pack dry-run OK (54 files). This does not replace actual runner evidence. That diagnostic-only head had production source identical to 1016db8a; the later capacity-reserve candidate described above changes intake/replay and still needs fresh runner acceptance.

## CI follow-up after the parent-only candidate

The Ubuntu additions were exactly a 32,768-byte SHM file and an empty WAL; DB and authored JSON hashes/modes were unchanged. A Linux Bun 1.4.2 probe imported only bun:sqlite and filesystem/crypto, created and closed a WAL database, then performed `new Database(file, {readonly: true})` plus SELECT: it produced the same two bookkeeping files with no CaptureStore import. A neutral readonly keeper now establishes that baseline before the existing exact file/hash/mode comparison. No authoring/FTS/schema/spool assertions were removed. A new regression keeps a writer open and proves readonly admission sees committed, uncheckpointed WAL rows while the main DB hash stays unchanged; using immutable reads would fail it. The exact-source Linux focused fixture verified 51 source/fixture hashes and passed six tests/27 assertions, as did native macOS. This is focused evidence only, not a full Linux gate.

For macOS, the original worker could spend the full work slice and then overrun while reaping/flushing metrics. Worker execution now leaves 25 ms inside the unchanged 140 ms handler budget. The original strict external `<150 ms` assertion remains. Full-tier recovery previously waited until after the brief, so a late brief could leave no time for even one append. Bounded recovery now runs with a 40 ms reserve for known work/serialization before brief work. Original `rows > 0`, event retention, known-work and context bounds remain. Deterministic tests fail against 0162265f on the worker-reserve assertion and on capture progress after a controlled late-brief clock advance; both pass with the fix. No external limit was raised. The unchanged native PreToolUse timeout and same-project full-tier SessionStart tests each passed 20 consecutive serial macOS runs after the phase-reserve fix. The later full gate passed both as well; actual runner results for the new head remain pending.

### Earlier runner history

Status: **macOS acceptance remains open**. The privacy fix at `1e4ec025e0359d05d515988b50da632f5a1545a8` passed Ubuntu but regressed SessionStart on actual macOS [run 39909819878](https://github.com/STAIxBWLB/agent-mem/actions/runs/39909819878), including a failed-job rerun. The preceding `b797a99b` passed both OSes but had the legacy-remote privacy finding. No passing local result below supersedes those runner failures. PR #34 remains unmergeable pending both-platform exact-head CI and the held privacy/performance verdict.

## Current candidate, parent-only native SessionStart

The previous `e07af3fa` candidate still failed actual macOS CI: the cold/noisy trace spent 45-70 ms on the second Bun startup before useful work. The current Option A candidate removes that startup from native SessionStart: work and only safe optional sections run in the parent CLI. Curated refresh is named unavailable, existing small capture indexes use a bounded read-only path, and the standalone library brief keeps all sources. Native metadata retains the shared Git identity and cache/privacy fences through owned asynchronous supervisors. An adversarial caller-SIGKILL probe found the initial supervisor could outlive its deadline; an armed native self-watchdog now reaps its nonce/PGID-verified group even without the caller. No second Bun boot or deadline increase was used.

The single-boot regression fails against the previous hook source and passes with parent context. A full-tier optional CaptureStore import failure was also reproduced as discarded context; moving the optional import inside its recovery catch preserves the completed brief, with native and library regressions. A suspended completion fence refuses even otherwise valid native identity and leaves no cache; removing that fence fails a named assertion. Remote/nested/linked resolver parity and a controlled native-read scope change are checked separately. Parent network/fault/cache probes target the actual brief/native port, with positive controls; worker probes remain for other hooks. The Git-overflow reaper test starts the actual worker after durable intake under an explicit fixture deadline so that it tests the entered overflow leg, while actual executable R1/R2 keeps its original bounds.

Pinned Bun 1.4.2, native macOS, synthetic isolated home, current runtime source before final documentation/tests:

| Path | Runs | Wall p95 (ms) | Wall max (ms) | Own combined peak (MB) | Raw combined peak (MB) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Plain capture | 40 | 44.67 | 59.93 | 72.89 | 72.91 |
| Contended capture | 15 | 40.55 | 40.55 | 68.45 | 68.47 |
| SessionStart known work | 20 | 46.86 | 47.69 | 45.44 | 45.44 |
| Drain | 1 | 44.78 | 44.78 | 68.34 | 68.45 |

R1 observed 76 invocations and 76 owned child roots (56 Bun workers, 20 native supervisors), with zero remaining processes/groups. All 55 original workload captures replayed exactly once, and 20 final SessionStart acknowledgements stayed durably pending. The unchanged diagnostic asserted output before 140 ms: cold attempt 0 returned known work and 429 bytes at 77.85 ms, warm attempts at 41.06-42.63 ms, and the prepared 256-record foreign tier at 79.35 ms. These are local results only. Native child RSS retains the documented Git-descendant omission ceiling; it is not an entire-process-tree peak claim. Raw inherited-rusage diagnostics and the independent CLI wait4 floor are retained.

The earlier parent focused suite passed 97 tests, 0 failed and 2 Linux-only RSS tests skipped on macOS; the additional async-identity suite passed 3 tests. The isolated-HOME AGENTS gate passed on the candidate: typecheck clean, `boundary: OK` (48 source files), 675 pass / 2 Linux-only skips / 0 fail, 9,764 assertions across 677 tests and 87 files (146.51 seconds), and npm pack dry-run OK (54 package files). New-head actual GitHub-runner results remain pending in the PR handoff. Acceptance remains open until Ubuntu and macOS are green at the exact head, two actual macOS runs pass, and actual runner numbers replace the pending runner readback. None of the older local/container tables below establishes that acceptance.

## SessionStart maintenance deferral

Runtime `89313a7043ecfbeac25be118ffcb90b484f4de01` keeps the legacy-remote and physical-root privacy bindings. Cache publication now sweeps stale temps only when its explicit internal maintenance option is enabled, which the fixed worker does only for non-SessionStart events. SessionStart can still resolve natively when its derived cache is full; it never guesses a project. The final cache-hit validity recheck already includes every semantic input, so the duplicate semantic scan at that same boundary is removed while retaining the stronger recheck.

The actual-SessionStart regression fails on the former runtime because the stale temp is removed, then passes with deferred cleanup and a later maintenance-enabled publication. The existing 128-temp cleanup and all legacy-remote invalidation assertions remain. The native focused suite passes 62 tests/1,860 expectations. Numeric runner diagnostics now split the stronger validity computation, mark cache maintenance/publication, and add a separately prepared 256-record foreign-full-tier SessionStart case; no deadline or success assertion is relaxed.

Frozen native macOS, Bun 1.4.2: plain capture p95 46.09 ms (70.56 MB own / 70.58 MB raw combined peak), contention 56.98 ms (68.06 / 68.08 MB), SessionStart 73.16 ms, max 79.35 (77.17 / 77.19 MB), drain 49.57 ms (66.88 / 66.89 MB). All 20 contexts retained known work, all 55 original captures replayed exactly once, and R1 found 76 invocations/helpers with zero leftovers. The cold diagnostic returned 365 bytes at 68.65 ms and the full-foreign-tier case 365 bytes at 76.60 ms, both with known work and no maintenance-sweep stage. The full isolated Linux AGENTS gate passed: typecheck clean, boundary OK (47 source files), 649 pass, 5 unavailable-shell skips, 0 fail, 9,540 expectations across 654 tests/82 files in 145.94 s; npm pack dry-run OK (53 files). These are local/container diagnostics, not GitHub acceptance; the new runner stages must explain the actual macOS result.

## Identity privacy follow-up

At `b797a99b46518917ee62ec2d4d1c7da24056288a`, both-platform CI was green, but final review reproduced a legacy-remote identity leak. Git can read `branches/origin` or `remotes/origin` without a configured origin. Runtime `80705bf1dc9454177bff818e63bead341b73d265` binds both files in both Git/common directories into pending scope and cache validity. It also refuses local-key caching unless the root hash is the physical cwd, retires old owned publication temps within a bounded scan, and corrects the developer-directory documentation (the fixed worker does not forward DEVELOPER_DIR).

All four new regressions failed on named assertions before the fix: both legacy remote formats retained the old scope, a symlinked core.worktree was cached, and 128 stale publication temps blocked cache admission. After the fix the identity-cache suite passes 10 tests/54 expectations. No prior assertion or deadline changed.

Frozen native macOS, Bun 1.4.2: plain capture p95 50.54 ms, contended 50.03, SessionStart 63.89 (max 64.20), drain 44.80. Own combined peak RSS: 71.34, 67.47, 77.94, 66.78 MB respectively; raw peaks: 71.36, 67.48, 77.95, 66.80 MB. R1 found 76 invocations/helpers and zero leftovers; all 55 original captures replayed exactly once and all 20 contexts retained known work. Cold diagnostic attempt 0 returned 365 bytes in 68.14 ms. The frozen-runtime Linux AGENTS gate also passed: typecheck clean, boundary OK (47 source files), 648 pass, 5 unavailable-shell skips, 0 fail; npm pack dry-run OK (53 files). New-head GitHub acceptance remains pending.

## Admission follow-up, minimal SessionStart retirement

Runtime: `c3167666ce5282aa9a34b093092f5b8dc8ab1b24`. A full tier previously retired 32 foreign records even when the incoming event needed only one slot, and repeatedly inventoried active/quarantine files. SessionStart now retires only enough for its event's file and byte capacity, defers unnecessary body cleanup when it already fits, and shares bounded inventories within the synchronous admission. Fresh destructive ownership checks, oldest-first order, the 32-file/256 KiB retirement bound, private quarantine and soft concurrent-publication ceiling remain unchanged. Non-SessionStart hooks retain healthy-admission cleanup.

Two named regressions fail against the prior runtime: the one-slot case retired 32 instead of one, and healthy SessionStart retired an unrelated orphan. Both pass with the fix. A third regression requires multiple retirements for byte capacity, preventing a file-count-only shortcut. The existing six-native-invocation foreign-full-tier test is unchanged.

Actual GitHub-runner R2 at the preceding published head `92ab7d42` (not acceptance of the new admission runtime):

| Platform | Path | Runs | Wall p95 (ms) | Combined peak RSS (MB) | Raw combined peak (MB) |
| --- | --- | ---: | ---: | ---: | ---: |
| macOS | Plain capture | 40 | 59.11 | 61.69 | 61.70 |
| macOS | Contended capture | 15 | 57.27 | 62.41 | 62.42 |
| macOS | SessionStart | 20 | 72.02 | 71.08 | 71.09 |
| macOS | Drain | 1 | 55.37 | 62.08 | 62.09 |
| Ubuntu | Plain capture | 40 | 53.59 | 86.78 | 95.57 |
| Ubuntu | Contended capture | 15 | 49.15 | 86.45 | 100.86 |
| Ubuntu | SessionStart | 20 | 73.57 | 90.84 | 105.52 |
| Ubuntu | Drain | 1 | 55.48 | 86.23 | 100.89 |

Each runner observed 76 invocations/helpers, zero leftovers and all 55 original captures exactly once. Ubuntu tests were 641 pass/5 skip/0 fail; macOS tests were 641 pass/4 skip/1 fail, the foreign-full-tier case above. Linux raw inherited-rusage remains diagnostic, with the previously reviewed per-image proof below.

Frozen admission runtime, local native macOS, Bun 1.4.2: plain capture p95 47.21 ms (max 62.87), contended 45.83, SessionStart 60.89 (max 62.48), drain 45.94. Own combined peaks were 71.34, 67.67, 77.89 and 67.11 MB respectively; raw peaks were 71.36, 67.69, 77.91 and 67.13 MB. R1 found 76 helpers and zero leftovers, all 55 original captures replayed exactly once, and all 20 known-work contexts passed. Cold diagnostic attempt 0 returned 365 bytes at 72.15 ms; attempts 1-4 also returned known work under 62 ms. The focused native suite passed 46 tests/1,614 expectations, including the unchanged foreign-full-tier case.

The isolated frozen-runtime Linux AGENTS gate passed: typecheck clean, `boundary: OK (47 source files)`, 644 pass, five unavailable-shell skips, zero failures, 9,519 expectations across 649 tests/82 files in 137.26 s; `npm pack --dry-run` OK (53 files). These local/container results do not replace new-head GitHub acceptance. No deadline, R2 threshold or existing success assertion was loosened.

## Round 3, native identity cache and cold import boundary

Candidate runtime: `e5cb1132f3edcd9d31b163ef7fdd964a7a65e8c5`. The native identity result is now derived-cached per cwd. A hit needs the current semantic scope, a stronger Git-validity hash (complete bounded config, regular HEAD, objects/refs and executable prefix config), and the current binary revision. The stronger binding prevents a cached result from hiding an unsupported Git format or corrupt HEAD while pending capture keeps its prior semantic stamp. Only the existing shared native resolver publishes a cache value; failed or unknown queries never do. The cache is private and bounded, and local linked/nested/submodule keys stay uncached. Full details are in the contracts.

The old static `resolveAlias -> shard -> generation -> mutation -> bun:sqlite` edge has been removed from worker startup. Alias functions and schema were moved unchanged to a shared leaf and re-exported through the existing API. This proves the dependency cut; it does not alone attribute the entire runner's 86 ms gap to SQLite. Darwin also resolves a root-owned selected developer Git directly when PATH selects Apple's shim, retaining custom PATH and all hardened arguments/environment.

A native warm-cache regression primes identity through the actual resolver, then refuses every native identity query. It still returns known work; removing the cache really fails the Git port. With the former worker, the named nonempty-output assertion fails. Other regressions cover origin/HOME/executable changes, malformed/oversized/symlinked receipts, private modes, the 128-entry ceiling, and Git-format/HEAD changes that intentionally leave the pending-capture stamp unchanged. The shared alias leaf resolves without loading SQLite mutation code. Existing capture/full-tier/exactly-once/process-group/network assertions remain. The standalone Git port continues to honor its passed PATH after the budget check. The isolated prune-writer mutation fixture adds the new alias module to its explicit copied import closure; its positive control and all three mutant assertions are unchanged.

Local native macOS, pinned Bun 1.4.2, frozen runtime `e5cb1132f3edcd9d31b163ef7fdd964a7a65e8c5`:

| Path | Runs | Wall p95 (ms) | Wall max (ms) | Combined peak RSS (MB) | Raw combined peak (MB) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Plain capture | 40 | 108.86 | 123.54 | 86.69 | 86.70 |
| Contended capture | 15 | 84.66 | 84.66 | 82.94 | 82.95 |
| SessionStart, known work | 20 | 101.73 | 104.79 | 84.34 | 84.36 |
| Drain | 1 | 101.92 | 101.92 | 83.25 | 83.27 |

R1: 76 executable calls and 76 helpers, zero leftovers. All 20 contexts contained known work, and all 55 original captures replayed exactly once. A preceding focused native check passed 57 tests with two Linux-only skips, zero failures and 1,841 expectations. The final runtime Linux AGENTS gate passed: typecheck clean, `boundary: OK (47 source files)`, 641 pass, five unavailable-shell skips, zero failures, 9,504 expectations across 646 tests/82 files in 140.59 s, and npm pack dry-run OK (53 files). Its separate four-test native-Git/prune-mutation regression run also passed unchanged assertions. These are local diagnostic results, not actual-runner acceptance. A separate local existing fake-Git overflow test did not reach its fake PID marker before timeout; this also reproduces with the pre-change worker and Git transport. The assertion is unchanged, and this local case is not reported as passing. The same case passes in the candidate Linux regression run; actual macOS CI still must run it.

The more detailed diagnostic now marks entry, input, policy, scope, executable resolution, cache hit/miss, brief import and work-store open. It guards the Bun spawnSync object form so instrumentation cannot break the reader lease's process-signature query. The final runtime fresh-cache local attempt 0 returned known work (365 output bytes) and stopped at 125.33 ms. Attempts 1-4 also returned known work and stopped at 93.28, 95.98, 106.67 and 99.48 ms; cache hits skipped Git. After recording all five attempts, the diagnostic itself now fails unless attempt 0 returns known work before 140 ms. It remains after the unchanged budget step, so it cannot warm the measurement it is intended to explain. The real macOS runner must pass this cold assertion as well as its unit tests and original 150 ms/100 MB R2 checks.

## Round 2, full-tier fairness and runner diagnostics

Integrated runtime candidate `39d8a9e7476ce46e6664b5d717566fc1bbb1db93`, rebased onto main `c53ddc4` (#383), fixes a separate reproduced starvation bug. With 256 valid pending records from existing project B, project A previously emitted no SessionStart context and retained none of its new events. At capacity, one bounded retirement pass can now move oldest valid foreign-cwd records into private quarantine, preserving their bodies without binding them to A. Healthy admission still retires unresolved records within the same bounds. Repeated capacity refusal after recovery retains its computed brief; the library receipt does not falsely report an unadmitted capture as durably pending. Concurrent publication can still exhaust the finite capture tier; this does not justify discarding a computed context.

The six-event cross-project native regression fails at the old head on the named nonempty-output assertion; it passes with all six events exactly once as a row or pending, no foreign capture in A, and bounded quarantine. A separate repeated-refusal regression is red before the brief-preservation catch and green after it. Existing same-project full-tier assertions are unchanged. The integrated runtime AGENTS gate passed: typecheck clean, `boundary: OK (45 source files)`, 635 pass, five unavailable-shell skips, zero failures, 9,466 expectations across 640 tests/81 files in 137.34 s; `npm pack --dry-run` lists 51 files. New-head GitHub CI remains pending.

Cold Mac timing is not closed by another local pass. After the unchanged budget step (so the diagnostic cannot warm it), a numeric-only diagnostic step records CLI boot, helper spawn/boot, hardened native identity calls, lease signature and reaping milestones on the real GitHub runner, even after a failed unit step. It never changes the hook deadline or budget assertions and logs no paths, payloads or tokens. A local four-call diagnostic showed helper boot around 21 ms, imports about 7 ms, the two Git identity queries around 9 and 12-16 ms, and the remaining lease/store/context work around 11 ms. These are a lead for actual-runner profiling, not the cause asserted for the runner's 164 ms failure. The runner's cold-path diagnosis and fix remain open. Before the rebase onto #383, a local native 1.4.2 check passed all 20 known-work contexts with p95 114.45 ms, max 117.03 ms and conservative combined peak 84.16 MB; 55 original captures replayed exactly once and R1 found zero leftovers. Those local numbers do not close the runner failure.

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
