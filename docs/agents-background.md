# AGENTS.md background

사람용 해설본. 에이전트 지시 정본: `AGENTS.md`. 절 번호는 정본과 같다.

## Pull requests

Draft PRs defer macOS tests and measurements to the ready-for-review run. The required macOS aggregate fails with `macOS deferred` while deferred, preventing a draft run from satisfying the merge gate. This follows the owner-approved #402 contract of 2026-11-14 to reduce macOS runner demand.

## Commands and verification

Agents working in this repository run only the typecheck, boundary check, the test files their change affects and `npm pack --dry-run` before reporting a change (#502). The full suite is about 365 files and roughly 43 minutes serial on Linux, and CI already runs it on both operating systems as a merge gate. In one test-only PR, a local full run held this repository's heavy slot for over 30 minutes while other heavy work waited. A local or remote full run is kept for when CI cannot run or a reviewer asks for it. Implement tasks that touch the CLI and policy boundary, a privacy screen or a storage format have their plan reviewed before code is written. Of 34 recently approved board tasks, 14 needed rework over 25 change-request rounds, and most review-loop time went to three tasks whose findings were acceptance-criteria readings and privacy-boundary gaps a plan review catches early. Each rejected round also costs an Ubuntu CI run of about 60 runner minutes.

## 변경 이력

- 2026-11-14: Added the draft-first PR flow and ready-for-review handoff in #402.
- 2026-11-14: The dgx02 remote slot cap now points to `dot remote status` `max_runs` (5 at the time) instead of a fixed 3, which had held back a verification in tasks 251/252.
- 2026-11-16: #431 removed the agent actor gates (read allowlist, sync-placement activation, history reads, brief cache, model consolidation, review walk refusal) and replaced the person-only `formats.json` rule with `amem formats raise`.
- 2026-11-20: #502 replaced the local full-suite completion check with the affected test files (CI holds the full suite) and added plan review before boundary, privacy-screen or storage-format changes; rationale in §Commands and verification above.
- 2026-11-20: #514 added the README-overview rule to §Conventions and structure; the #502 rationale moved here from README §Development.
- 2026-11-21: #538 permits a checked host API range for vault-link-capable hosts while retaining the P2 minimum.
- 2026-11-24: Added the host-facing dependency rule to §Things agents get wrong. agent-hub's recovery package checked agent-mem's declared dependencies and refused 0.37.0, so `ahub upgrade` failed (agent-hub#1664). One shared `@staix/cli-output` version across amem, agent-hub and vault-mem also keeps a single installed copy.
