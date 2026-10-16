# Changelog

## 0.2.0

- Reads select note rows in SQL before building views (agent-hub#412 P6): at 200,000 notes read p95 -45 %, search -39 %, write -31 % (docs/bench/p6-results.md). Metadata, operations and rows come from one read snapshot.
- The command header's long/short totals count only rows the host's readable policy allows.
- Candidate boundary (agent-hub#412 P7a): `CandidateStore`, a machine-local `candidates.db` for correction, fail and decay candidates and rendered/delivered/cited counters; never synced, imported or read by list/search/graph. Person-only `amem review` with accept/reject; accepting writes ordinary v1 entries (a correction as a note plus `supersede`, a fail as a long-term note) after the host's promotion screen.
- A machine-local `mutation-lock.db` serializes this version's writers (append, import, sync, acceptance); older or external writers are not serialized (README).

## 0.1.1

- First release through the tag workflow with npm trusted publishing (OIDC) and provenance; pins npm 11.20.0 in the release job.
- New subpath export `@staix/agent-mem/platform` (deny list, hardened git, realPath, process identity): it imports only `node:` built-ins, so Node hosts can load it; the root entry loads `bun:sqlite` and needs Bun.

## 0.1.0

- Initial standalone `@staix/agent-mem` library and person-only `amem` CLI.
- Compatible append-only memory storage, derived SQLite index, tiers, graph, goals and private git sync.
- Static zsh, bash and fish completion from shared CLI definitions.
- Agent-session refusal, terminal-only mutations and explicit `--policy-free` boundary acknowledgement.
- Synthetic agent-hub 0.12.29 output parity fixtures and portable core regressions.
