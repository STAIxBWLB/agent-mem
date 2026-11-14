# AGENTS.md background

사람용 해설본. 에이전트 지시 정본: `AGENTS.md`. 절 번호는 정본과 같다.

## Pull requests

Draft PRs defer macOS tests and measurements to the ready-for-review run. The required macOS aggregate fails with `macOS deferred` while deferred, preventing a draft run from satisfying the merge gate. This follows the owner-approved #402 contract of 2026-11-14 to reduce macOS runner demand.

## 변경 이력

- 2026-11-14: Added the draft-first PR flow and ready-for-review handoff in #402.
- 2026-11-14: The dgx02 remote slot cap now points to `dot remote status` `max_runs` (5 at the time) instead of a fixed 3, which had held back a verification in tasks 251/252.
