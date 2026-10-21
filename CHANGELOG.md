# Changelog

## Unreleased

- Defer capture MCP FTS creation/backfill to queried reads so an upgrade cannot scan a large shard on a hook. Contended reads use a policy-screened, call-pinned substring fallback and retry indexing later; triggers cover pre- and post-initialization appends (#13, agent-hub task #327).

- Keep MCP search, timeline and point reads usable beyond 5,000 rows: page exact-project query candidates in SQL/FTS, screen before the public window, preserve full capture path/event matching, and stream cold curated FTS rebuilds. Measure real stdio R3 on 5,001 curated plus 5,001 capture rows (#13, agent-hub task #209).

## 0.4.0

- Add the capture tier, born sharded: one capture store per project key at `projects/<key-hash>/machine/<machine-id>/`, deterministic rows only (no network or model call), deny-screened paths, a bounded secret-screened excerpt, a spool on lock contention, and R6 cap and retention bounds resolved per shard. A pre-T1 machine-wide capture store drains into its shards on open (#13 P1, #15 T1).
- Add FTS5 search over the curated tier and the current project's capture shard (`store.search`), ranked by BM25 with tier and recency weights, prefix terms with a Korean-particle alternative, the project filter inside the query, and a substring fallback. The curated FTS copy is its own derived `search.db` (#13 P1).
- Project identity (#15 D2): a no-remote repository's key hashes its main working root, so the root, its subdirectories and worktrees share one key (except a separate-git-dir worktree, below) and root-written keys keep their pre-#15 value. Add person-only `amem alias add` and `amem alias list` (append-only, never chained): an alias maps a project to its canonical key for capture, work lists and the CLI and MCP project binding, while curated rows written under the old key are not remapped: the CLI and MCP no longer show that key's project-scoped notes, goals and candidates (the library still reads them by the raw key, and shared rows stay visible). An alias can be retargeted but not removed. Add a derived `catalog.db` (#15 T1, #13 P2).
- Add the R7 capacity advisor (`capacityReport`, `amem capacity`: shrink-only proposals behind a saved preview and `--confirm`; explicit values are the person's call) and the R1-R3 budget script, run in CI on macOS and Linux (#13 P1).
- Packaging: `bin` reads `bin/amem.js` so npm no longer rewrites it on publish, and CI fails on any `npm pkg fix` diff.
- Shard migration apply and resume hold each destination shard's writer lock from a last tail check through the copy, so a shard writer that crashes after preflight can no longer leave the split `captured` and unreadable; a busy writer refuses with the journal unchanged. A torn tail refusal names the file and the person-run recovery (docs/curated-shard-migration.md, "Recovering a torn shard tail") (#15 T2 follow-up).
- Search no longer recalls a capture row past its shard's retention window before a later append evicts it: the retention cutoff and `since` run inside the capture query. Curated search reads FTS candidates in fixed-size pages until it has `limit` visible hits or the index is exhausted, so superseded, forgotten or pre-`since` rows can no longer hide a visible match and memory stays one page. `SearchFilter.captureRetentionDays` carries a host's capture `retentionDays` override into search. Capture stores each row's time as canonical UTC ISO text and refuses an `at` that does not parse. README records the separate-git-dir worktree key limit (#13 P1 follow-ups).
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
