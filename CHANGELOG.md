# Changelog

## Unreleased

- Shard migration apply and resume hold each destination shard's writer lock from a last tail check through the copy, so a shard writer that crashes after preflight can no longer leave the split `captured` and unreadable; a busy writer refuses with the journal unchanged. A torn tail refusal names the file and the person-run recovery (docs/curated-shard-migration.md, "Recovering a torn shard tail") (#15 T2 follow-up).
- Keep CLI candidate/vault project aliases consistent with MCP, bound work-list materialization before parsing, and verify held reader leases without repeated process scans (#13 P2).

- Add session-scoped nine-tool MCP, composed standalone privacy policy, candidate-only remember, project work lists and reviewed-alias work-state import (#13 P2).
- Add read-only vault candidates and exact-entry generation-local vault links without changing shared-v1 operations; measure real MCP R3 budgets on both CI platforms (#13 P2).

- Add person-run curated project/user shard migration with a read-only bridge, selected-generation prune preservation, independent reader admission and shared pruning; requires shard-aware host integration before live use (#15).

## 0.3.1

- Add opt-in legacy settlement queries for host approval reconciliation after generation migration, preserving own-note expiry and promotion semantics (agent-hub#432).

## 0.3.0

- Generation profile (agent-hub#412 P9, #9): opt-in, person-run migration to `M/generations/G` with its own logs, index, locks and Git ref `amem/gen/G`; machine-local selector changed by compare-and-swap; `amem migrate --dry-run | --resume | --deactivate`. Shared v1 stays the default and its behavior, sync included, is unchanged.
- Read-only legacy bridge over raw v1 JSONL: ids preserved, malformed lines skipped and counted as in shared v1, no Git on ordinary reads.
- Durable exact-entry prune in a generation (`amem prune`): explicit target id and row hash, expiry proven only by an explicit `expires`/`by`; private targets stay in local rows. Closes C05 for pruned entries; the shared-v1 C05 ceiling stays.
- Contract gates extended: real 0.1.1 and 0.2.0 readers, sync isolation, replay, privacy and migration crash points.
- Do not migrate a home agent-hub uses until agent-hub binds the profile (#9 rollout).

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
