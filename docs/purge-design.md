# Purging an entry that leaked a secret or personal data (design)

Design for #175 (part of #178). **Design only: no implementation.** It touches the storage invariants in `AGENTS.md`, so the owner decides; the decision is recorded on #175 and implementation gets its own issue.

## Problem

When the screen misses a secret or personal data (for example, a PII pattern added after the text was stored), amem can hide the entry but cannot remove it. `forget` and generation `prune` (`exact-entry-v1`) mask exact entry IDs in every derived view, but the authored row stays in the append-only log, in raw dumps and, once synced, in the private remote's Git history (`docs/contracts.md` §Generation-only prune, §Per-shard private sync). `AGENTS.md` §Storage invariants says "Never rewrite a log line", so any real removal needs an owner decision.

Terms: *mask* means a reader can no longer see the text through amem; *purge* means the bytes are gone from a given location. Every location below needs a purge, a mask or an explicit "out of reach" statement.

## 1. Inventory: where one entry's text can live

Paths are relative to the memory home `M` (`memoryHome()`: `AMEM_HOME`, else the pointer in `amem.config.json`, else `~/.agenthub/memory`). `K` is a project key hash, `m` a machine id, `G` a generation id.

| # | Location | What holds the text | Authoritative? | Today after `forget`/`prune` |
|---|---|---|---|---|
| 1 | Shared-v1 curated logs `M/log/<m>.jsonl`, `M/local/<m>.jsonl` | the full canonical authored row (append-only segments) | yes | row kept; masked in views |
| 2 | Generation logs `M/generations/G/log/`, `.../local/` (legacy unsplit generation) | same row, possibly bridged from legacy | yes | row kept; masked |
| 3 | Curated shards `M/projects/K/...` (split homes, #15) and their generation segments | same row | yes | row kept; masked |
| 4 | `index.db` / `index-v2.db` (home, generation, shard and `work/` variants) | derived copy of text and FTS | no (derived) | row hidden; text may persist in SQLite free pages and WAL until vacuum |
| 5 | `search.db` / `search-<G>.db` | derived FTS index | no | same as 4 |
| 6 | `catalog.db`, `reader-admission.db`, `mutation-lock.db` | metadata only (no entry text) | no | n/a |
| 7 | Capture shards `M/projects/K/machine/<m>/capture.db` (+ `-wal`), capture spool `spool-*.jsonl` | screened excerpt of a hook event or import (text near the leak, often the leak itself) | capture tier, machine-local | not masked by `forget`; aged out by retention/cap only |
| 8 | `M/hook-spool/` (and `.capacity/`, `.quarantine/`) | normalized pending hook capture | transient | drained or retired; quarantine keeps a metadata receipt, not text |
| 9 | `candidates.db` (+ `-wal`) | proposed text of candidates, accepted or rejected | sidecar, machine-local | not masked |
| 10 | Work lists `M/projects/K/work/log/`, `work/index.db` | work-list item text | yes (own append log) | not covered by `prune` |
| 11 | `metrics.jsonl`, `setup/` receipts, `hook-project/` cache | counts, paths and config images (no entry text by design) | n/a | n/a |
| 12 | Export files from `amem project export` (json/jsonl/markdown) | full authored rows | person-owned copies, anywhere on disk | out of amem's reach |
| 13 | Generation snapshots and migration sources (`M/generations/G/` for an older G, `migration-sources.json`, the legacy root after migration) | older full copies | historical | kept by design ("deactivation retains both histories") |
| 14 | Local sync working tree and Git object store: `M/.git` (shared-v1 sync), generation repo `refs/heads/amem/gen/G`, `M/shard-sync/objects.git` (per-shard packs, `prune-holds/` receipts) | every published row in packs and commits | transport | objects retained; automatic GC is disabled for the shard cache |
| 15 | The private sync remote and its full history (`main`, `amem/gen/G`, `amem/p/<hash>`, `amem/u`) | every published row | transport | history is append-only and audited; a rewrite is refused ("remote history is not fast-forward" for shard sync, "legacy main history is not fast-forward" for generation sync) |
| 16 | Other machines' homes and clones that already fetched the row | items 1-15 on those machines | per machine | masked only after they sync the prune |
| 17 | Host and OS copies: agent transcripts, terminal scrollback, Time Machine or other backups, editor swap files | arbitrary | outside amem | out of reach |

Items 1-3 and 15 are the ones the invariant protects; 4-5 are fully derived and can be rebuilt; 7-10 have their own lifecycles; 12, 16 and 17 are out of reach.

## 2. Options

### a. Purge through a new generation migration that leaves the target out

A person-only `amem purge <full-entry-id> [--confirm]` writes a new generation G' by replaying every authored row of the active generation except the purged targets (and rows whose only content is a target, such as its settlement or promotion copy), then activates G' through the existing migration path (`profile.lock`, staged rebuild validation, selector replacement as the last commit point). After verification, the outgoing generation's segments, indexes and Git repo are deleted. A purge record (ID and row hash only, no text) is appended to G' so other machines can apply the same cut.

- No existing log line is rewritten: G' is new append-only data; the old generation is deleted, not edited.
- Deleting the outgoing generation is not enough: the text also sits in amem-owned historical copies (items 13-14), namely the legacy shared-v1 root (`M/log/`, `M/local/`) and its `M/.git` store, earlier inactive generations under `M/generations/`, migration sources, and the shard-sync object cache `M/shard-sync/objects.git` (with its `prune-holds/`). Option a must purge every one of these copies that contains the target (by replaying or deleting it under the same verification, and expiring and repacking the object cache) before its receipt may say local bytes are gone. Which of them a purge may delete, versus only report, is a decision point for the option a issue; until it is decided, the receipt lists each copy it left in place.
- Derived DBs (4, 5) are rebuilt from G' rather than vacuumed, so no free-page residue survives.
- Capture, candidates and work lists (7, 9, 10) need their own targeted deletes keyed by the same text search (they are not part of the generation).
- Remote (15): G' publishes on a new ref; the old ref must be deleted on the remote, and Git history is not rewritten. A remote host that keeps unreachable objects or reflogs may still serve the old blobs until it collects garbage.

Cost: large. It reuses the migration machinery but needs a "replay minus targets" planner, closure rules for dependent rows (supersede chains, promotions, settlements, prunes that target the purged row), a deletion step with crash safety, a cross-machine purge record, and changes to the sync audit so a deleted ref is not reported as `previously synced remote ref disappeared`. Every purge costs a full rebuild, which takes minutes on a large home.

Breaks: the invariant "Preserve segment paths" (old segments disappear), sync's refusal of a vanished ref, `bridgeStatus` and migration receipts that point into the deleted generation, and any reader leased to the old generation (it must be drained first). Generation IDs in exports and vault links become dangling.

### b. Local redaction operation plus a documented manual remote rewrite

A person-only redaction op (`agent-mem.redact/v1`, append-only like prune) names a full entry ID and row hash. Readers mask it like prune. A separate offline compactor rewrites the segment file that contains the row, replacing the row's `text`/`title` with a fixed tombstone while keeping its `id` and hash fields so later rows that reference it still resolve. The remote is cleaned by a documented manual procedure (`git filter-repo` on a fresh clone, force-push, re-clone on every machine).

- Local purge is complete for items 1-5 after the compactor and a rebuild plus `VACUUM`.
- The remote rewrite is the person's job and breaks every other machine's clone until each re-clones.

Cost: medium for code (op, mask, compactor, vacuum), high for the person (manual history rewrite, coordination across machines).

Breaks: "Never rewrite a log line" directly (the compactor edits a line); the content-addressed entry ID no longer matches its text, so the hash-chain and full-prefix checks must learn an exception; sync's append-only and ancestry audits refuse the rewritten remote by design, so the audit needs an explicit, person-confirmed "accept rewritten history" path. This is the option most at odds with the current integrity model.

### c. Documented procedure only, no code

Document what to do today with existing tools:

1. `amem forget <id>` (or a person-authored prune) so no amem reader shows the entry anywhere, including on other machines after sync.
2. Rotate or revoke the secret. This is the only step that makes a leaked credential harmless.
3. For local bytes, the default is to accept that the masked row stays on disk. A rebuild is opt-in: stop every amem and hub process, list every project (`amem projects --all --json`), export each one, delete (never edit: import checks each row's id against its content) the leaked line from its export, rename the old home aside, import every export into a fresh home, and delete the old home only after every project is restored and the person has accepted what cannot be carried over (lifecycle operations, capture, goals, work lists, notes outside any project export, candidates, generation history and sync state). In a multi-project home, never delete the old home while it holds anything not restored.
4. For the remote: create a new private remote, re-sync from the cleaned home, and delete the old remote; or run `git filter-repo` and re-clone everywhere.
5. Delete capture shards, `candidates.db` and stale exports for the affected project (all machine-local and rebuildable or disposable).

Cost: small (documentation and maybe a `doctor` hint). Breaks nothing.

Limits: relies on manual steps that are easy to get wrong; a rebuild loses lifecycle operations (`supersede`, `demote`, `settle`, `forget` are not exported, per `docs/contracts.md` §Native-memory candidates and portable projects), capture, goals and work lists (export-only), and notes no project export selects; no machine-checked verification that the text is gone.

### Comparison

| | Local logs (1-3) | Derived (4-5) | Capture/candidates/work (7, 9, 10) | Remote (15) | Other machines (16) | Code cost | Invariant change |
|---|---|---|---|---|---|---|---|
| a | purged (outgoing generation and the historical copies 13-14 that hold it) | rebuilt | needs targeted deletes | new ref; old ref deleted; host GC needed | apply purge record on next sync | large | segment paths and vanished-ref refusal |
| b | redacted in place | rebuilt and vacuumed | needs targeted deletes | manual history rewrite | re-clone | medium | "never rewrite a log line" |
| c | masked only (or manual rebuild) | masked | manual delete | manual new remote | manual | small | none |

## 3. What stays out of reach, and how the person is told

No option can reach: other machines that are offline or never sync again (16), export files the person copied elsewhere (12), OS and host copies such as backups, agent transcripts and terminal scrollback (17), and a remote host's retained unreachable objects, reflogs, forks or caches (15).

How the person is told:

- The purge (or forget) receipt names every location it **did** clean, every location it **could not** reach (by category, without echoing the text), and the counts of capture rows, candidates and work items it found near the target.
- It always prints the one action that actually neutralizes a leaked credential: rotate or revoke it.
- `amem doctor` reports a pending purge record that has not yet been applied on this machine, and other machines' doctors report it when they fetch it.
- No message ever repeats the leaked text; receipts carry entry IDs and row hashes only.

## 4. Recommendation

**Start with c now, then a; do not do b.**

- **c (now):** write the procedure as `docs/purge.md` (or a README section), plus two small mechanical helpers that change no invariant: a `forget` receipt that lists capture rows, candidates and work items matching the target text so the person can delete them, and a `doctor` line explaining that masked rows remain on disk and in sync history. This closes the "no way" gap honestly at almost no risk.
- **a (later, own issue):** a generation-based purge is the only design that removes bytes without editing a committed line, keeps derived equality (rebuild from G') and fits the existing migration, profile-lock and selector machinery. It should be specified with its closure rules and the remote ref deletion before any code.
- **Not b:** in-place redaction breaks the content-addressed, append-only, ancestry-audited model that the sync and prune proofs rely on, and pushes the hardest step (remote rewrite on every machine) onto the person.

### AGENTS.md §Storage invariants wording option a would need

Proposed replacement for two bullets (to be adopted only with the owner decision):

- Preserve segment, `machine.json` and `sync.lock` paths **of the active generation**. A person-confirmed purge may delete an inactive generation's segments, indexes and Git refs after the replacement generation is active and verified; nothing else deletes a segment.
- Never rewrite a log line. Express every change as a new entry. **A purge expresses removal as a new generation that omits the target; it never edits, truncates or reorders a committed line.**

And one new bullet:

- A purge is person-only, takes full entry IDs, writes only IDs and row hashes (never text) to its record and receipt, rebuilds every derived DB from the new generation instead of vacuuming in place, and reports every location it did not reach.

Option c needs no invariant change.

## Open questions for the owner

1. Is the long-term goal "no amem reader shows it" (already met by forget/prune) or "the bytes are gone from this machine and the remote" (needs a)?
2. Should a purge on one machine propagate to others automatically (purge record over sync), or stay local with a printed instruction?
3. Is deleting an inactive generation acceptable, given that deactivation currently promises to retain both histories?
4. For capture and candidates, is a text-match delete acceptable, or must the purge only use exact IDs (which those tiers do not share with curated rows)?
