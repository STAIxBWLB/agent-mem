# agent-mem

Curated memory with append-only JSONL logs, a derived SQLite index, short- and long-term tiers, a typed graph, goals with leases, and git sync between machines. Extracted from [agent-hub](https://github.com/STAIxBWLB/agent-hub), with compatible storage and entry IDs.

Version: 0.3.1. Requires Bun 1.4.2 or later; no runtime dependencies.

## Install

Install the public package:

```sh
bun add -g @staix/agent-mem
amem --version
amem --help
```

From a checkout, install development dependencies with `bun install` and run `bun src/cli.ts --help`.

## CLI

The flat `amem` commands mirror `ahub memory` arguments; goals use `amem goal`:

```sh
amem list --json
amem search "release decision" --limit 10
amem show <id> --json
amem graph <id-or-node> --hops 2 --json
amem suggestions
amem goal list --all --json
amem goal new "Ship a release" --milestone "Review changes"
```

`amem goal link` requires the host task boundary; use `ahub goal link` for board links.

Memory commands: `list`, `search`, `show`, `graph`, `suggestions`, `confirm`, `reject`, `promote`, `demote`, `forget`, `supersede`, `rebuild`, `dedupe`, `sync`, `machine`, and `import`. Use `--json` where supported by the corresponding `ahub memory` command. `dedupe` previews candidates; `dedupe --apply` appends reconciliation operations. `amem alias add|list` manages person-reviewed project key aliases; `amem capacity` reports and proposes capture bounds (see below).

Ordinary `amem` commands are for the person and refuse agent-session markers, including `AGENTHUB_PEER_ID`, `CLAUDECODE`, and `CODEX_THREAD_ID`. `amem mcp` is the sole intentional session agent entrypoint; it supplies scoped reads and bounded candidate/work-list writes, never direct curated-note writes. Hosted agents can also use the hub's `hub_memory_*` read tools. Environment-marker detection is an honest-session guard, not authentication. Ordinary CLI mutations remain person-only and require a TTY on stdin.

This package does not ship the host's privacy policy. Ordinary person reads show stored data without screening; the vault-candidate listing uses its current policy. Import and promotion retain the built-in secret screen. Commands that cross the privacy boundary require the person's explicit `--policy-free` choice:

```sh
amem promote <id> --policy-free
amem import claude-mem --db <path> --policy-free
amem sync --remote <private-git-url> --policy-free
```

Use `ahub memory` for the policy-applying path. `--policy-free` does not bypass the secret screen or the sync remote's privacy checks. Forgetting a shared note appends an operation; its previous content remains in the remote's git history.

## Candidate review

`amem review` lists this project's pending machine-local candidates. They are proposals, not memory notes and not evidence. Use JSON to inspect the complete candidate payload before accepting or rejecting its full 64-character ID:

```sh
amem review --json
amem review list --kind correction --status all --limit 50 --json
amem review accept <full-candidate-id> --policy-free --json
amem review reject <full-candidate-id> --json
```

All review commands remain person-only; acceptance and rejection require a terminal on stdin. Acceptance additionally requires `--policy-free`, acknowledging that the standalone CLI cannot apply a host's privacy policy; use `ahub memory` for the host policy path. The CLI refuses secret-looking candidate input or proposed note content. Listing does not open the ordinary memory index, and acceptance defers unrelated held-note promotions.

Candidates live in `candidates.db` beside the memory logs. This sidecar is machine-local: it is never synced, imported, or read by recall, briefs, ask or graph evidence. Hosts must supply an explicit public privacy verdict before putting candidates or counters; private, PII and unknown verdicts are refused. Library APIs are available, but this phase adds no automatic candidate producer or telemetry consumer. Candidate retention is 500 per project and 30 days; counters retain 10,000 per project and 90 days. Candidate payloads are capped at 16 KiB.

Acceptance creates ordinary v1 memory data. A correction retains its target's scope, project and storage reach, writes the corrected note and applies the existing `supersede` operation; its exact current target revision must match. A local target stays short-term; a synced target stays synced, including a demoted target whose effective tier is short. A fail becomes a long-term project note. The accepted text binds the candidate ID, target revision and target ID; a fail proposal without a target records `none` for both target fields. Both paths require the actual MemoryStore promotion screen to return `promote` at acceptance time; `keep`, `skip` or an absent screen refuses acceptance without falling back to short-term storage. Accepted v1 notes and operations follow the existing storage and sync rules; the candidate/counter sidecar remains local and outside evidence. No new v1 operation is introduced. Decay candidates are listing-only and cannot be accepted; a person may separately choose `ahub memory demote` or `forget`. The sidecar receipt, note append and correction's supersede append are separate durable writes. An interrupted acceptance can leave a note without its supersede; it is held for explicit inspection and never replayed automatically.

The library entry exports `CandidateStore({ home?, now? })`, `put(input, verdict)`, `recordCounter(key, values, verdict)`, and `accept(id, { project, actor, verdict, store, policy })`. `home` retains the parent-home convention (`<home>/memory`); the default uses `memoryHome()`. The host must authenticate person intent, bind the current project and privacy verdict, and supply a current acceptance policy plus the ordinary store's actual promotion screen. An `actor` string or caller-supplied public verdict alone is not authentication. Counter writes are idempotent snapshots for the same contextual key, not increments: observed `0` stays zero, while `null` means unknown (a later unknown value does not erase an observed value).

Open a review-only `MemoryStore` with `deferPromotions: true` to prevent unrelated automatic promotions during construction and reads. Explicit candidate acceptance still runs its promotion screen. This package registers no capture observer or host candidate tools; capture exclusion and authenticated producers must be established by the host before those integrations are enabled.

Acceptance normalizes its note once, including timestamp, content ID and short-term expiry, then screens and appends that exact body. The final target-revision check and correction appends hold the same machine-local `mutation-lock.db` writer transaction used by this version's ordinary memory, import and sync writers. This lock is independent of the derived index, so an ordinary write still persists when SQLite is busy. External or older writers that edit segments without this lock do not participate in serialization. The logs remain authoritative after an interrupted acceptance; the next read refreshes the derived index.

## Shell completion

Generate completion for `zsh`, `bash`, or `fish` with `amem completion <shell>`. Generation prints a script to stdout; it does not install files or edit shell configuration. The following commands are for a person's terminal.

### zsh

```sh
mkdir -p ~/.zfunc
amem completion zsh > ~/.zfunc/_amem
```

Enable it by adding these lines to `~/.zshrc`, placing `fpath` before your existing `compinit` call (use only one `compinit` call):

```sh
fpath=(~/.zfunc $fpath)
autoload -Uz compinit
compinit
```

Start a new shell. After upgrading amem, regenerate `~/.zfunc/_amem` with the same command and start a new shell. To remove it, delete `~/.zfunc/_amem` and start a new shell; remove the added `fpath` entry only if no other completions use that directory.

### bash

```sh
mkdir -p ~/.local/share/bash-completion/completions
amem completion bash > ~/.local/share/bash-completion/completions/amem
```

Enable it by adding this line to `~/.bashrc`:

```sh
source ~/.local/share/bash-completion/completions/amem
```

Source that file or start a new interactive Bash. After upgrading amem, regenerate it and source it again. To remove it, delete that file, remove its source line from `~/.bashrc`, and run `complete -r amem` in the current shell (or start a new shell).

### fish

```sh
mkdir -p ~/.config/fish/completions
amem completion fish > ~/.config/fish/completions/amem.fish
```

Fish loads this directory automatically. Start a new fish shell. After upgrading amem, regenerate the file and start a new shell. To remove it, delete `~/.config/fish/completions/amem.fish` and start a new shell, or run `complete -c amem -e` to clear the current shell's definitions.

### Manual Tab checks

These interactive checks remain unrun until a person checks them in each installed shell; automated syntax/candidate tests do not establish terminal behavior.

- Type `amem ` and press Tab: top-level commands appear.
- Type `amem goal ` and press Tab: goal subcommands appear.
- Type `amem list --tier ` and press Tab: `short` and `long` appear.
- Type `amem goal state <id> ` and press Tab: goal states appear.
- Type `amem import claude-mem --db ` and press Tab in a directory containing a filename with spaces: the path remains one argument.
- Type `amem completion ` and press Tab: `zsh`, `bash`, and `fish` appear.

## Data directory

`memoryHome()` selects `AMEM_HOME` first, otherwise `$AGENTHUB_HOME/memory`, otherwise `~/.agenthub/memory`. `AMEM_HOME` names the memory directory itself; `AGENTHUB_HOME` names its parent. Existing agent-hub memory directories need no migration. An explicit `StoreOptions.home` retains the parent-directory convention and appends `/memory`.

The JSONL segments are authoritative. `index.db` is derived and can be rebuilt. Entries are immutable; changes append operations. The compatibility schema remains `agent-hub.memory/v1` because it participates in entry IDs.

## Capture tier and full-text search

From issue #13 (phase P1), the package carries a second, machine-local tier beside the curated store, born sharded (#15 T1): one capture shard per project key at `projects/<key-hash>/machine/<machine-id>/` under the memory home, with its own locks so two projects never contend. The capture tier records deterministic tool-event rows (project, agent, event, tool, paths, exit status and a bounded, secret-screened excerpt) in the shard's `capture.db`. It is never synced, never read as curated evidence, and never writes a curated log, so its maintenance can never evict notes, goals or work lists. Capture is bounded by a soft size cap and a retention window (defaults 512 MB per shard, 90 days), resolved at every invocation from the library options, then the shard's `config.json`, then the home default `capture-config.json`; eviction removes the oldest capture rows first in bounded batches. The 2026-10-17 owner decision keeps the P1 cap per shard; the machine-wide total is #15 T5. On lock contention a writer appends to an append-only spool and exits fast; the next uncontended writer replays the spool idempotently. The capture path makes no network or model call. The pre-T1 machine-wide `capture/` (an unreleased layout of this branch) is migrated per project on open and removed once empty.

Project identity (#15 D2) keeps `memoryProjectKey`: a worktree, a submodule and the main checkout of one repository share its key; two unrelated same-named repositories without a remote get distinct path-hash keys, flagged `local` in the shard's `project.json` and the catalog. A no-remote key hashes the main working root (using the actual top-level for a separate git dir), so keys written from the repository root keep their pre-#15 value. Keys written by older builds from a subdirectory or worktree still used that invocation's cwd hash; a person-reviewed alias reconciles those historical keys **for capture only**. Curated `list`/`search` still filter on the raw key; curated alias resolution is a later spec change. `amem alias add <from-key> <to-key>` appends an op to `aliases.jsonl` (latest wins, never chained, never automatic), `amem alias list` shows the ops. `catalog.db` in the memory home (#15 D3's storage part) is derived only from the shards and the alias log and rebuilds to the same rows; the D3 management commands are #15 T5 and not built.

`store.search(query, filter)` searches the curated tier and the current project's capture shard with SQLite FTS5 and BM25 plus tier/recency weighting: natural multi-word queries match partial term sets (the substring filter required every word), and a curated row outranks the same text in the capture tier. Prefix terms match inflections and Korean particles in either direction by retaining the original query term and adding a common-particle-stripped alternative. The FTS copy of the curated rows lives in its own derived `search.db` (`index.db`'s table set is a frozen contract and gains nothing); it is written from the same apply path as the index, and a prune, crash or rebuild is detected and resynced, so the incremental FTS copy equals a full resync. Where FTS5 is unavailable the engine falls back to the substring filter and reports `engine: "substring"`; capture recall needs FTS5 and is skipped in the fallback. The library entry exports `CaptureStore`, `captureSearch`, `readCaptureConfig`, `writeCaptureConfig`, `SearchIndex`, `fts5Available`, the shard helpers (`resolveAlias`, `appendAlias`, `listAliases`, `shardKeyHash`), the catalog (`rebuildCatalog`, `readCatalog`, `scanCatalog`) and the capacity advisor (`capacityReport`).

The R7 capacity advisor reports this machine's load and proposes capture bounds: `amem capacity [--json]` shows capture size and growth, disk, memory, the rolling `metrics.jsonl` readings and the proposal with its binding constraint; `amem capacity apply [--cap-mb N] [--retention-days N]` saves a preview, and only a matching later `--confirm` writes the home default config. Applying is person-only (agent markers refused, a terminal required); an agent may read the proposal through the library, never apply it. The 2026-10-17 owner decision keeps P1 shrink-only; growth proposals are a follow-up after the agent-hub release, while explicit person-directed growth remains available through `apply --cap-mb N`. Benchmark samples stay in the measuring script's synthetic home; only real hook and search invocations feed the advisor's rolling metrics.

Resource budgets are acceptance criteria, measured by `bun scripts/measure-budget.ts` in CI on Ubuntu and macOS: a hook-like append (including the spool-and-exit path under contention) must stay under 150 ms p95 wall time and 100 MB peak RSS (R2), the search path under 100 MB idle and 200 MB peak RSS (R3), and no amem process may remain after exit (R1). The script prints a machine-readable verdict per budget and its CI log is also the FTS5 availability evidence for Linux (R5). The AC4 retrieval re-check of the frozen P0 query set is in [docs/p1-ac4-recheck.md](https://github.com/STAIxBWLB/agent-mem/blob/main/docs/p1-ac4-recheck.md).

## Library

```ts
import { MemoryStore, memoryProjectKey } from "@staix/agent-mem";

const store = new MemoryStore();
try {
  const notes = store.list({ project: memoryProjectKey(process.cwd()) });
  console.log(notes);
} finally {
  store.close();
}
```

The root entry needs Bun (it loads `bun:sqlite`). Node hosts that need only the deny list, hardened git invocation, `realPath` or process identity import `@staix/agent-mem/platform`, which uses `node:` built-ins only.

The entry point exports the store, types and identity helpers, sync and claude-mem import, project/home helpers, raw memory/goal command handlers, and platform helpers. Hosts inject their own privacy policy through `StoreOptions.screen`; CLI wrappers can supply screened reads and import policy through the raw command options.

## Contracts

Shared segments retain the `agent-hub.memory/v1` profile. `OP_CONTRACTS` and `V1_OPS` keep the shared-v1 operation contract; both shared append paths refuse unknown or truth-changing operations. The separate `GENERATION_OP_CONTRACTS` enables `prune` and local exact-entry `vault_link` after an explicit generation selection. `correct`, `lift`, `consolidate` and `group` remain blocked. Reader announcements cannot authorize a new operation or relax generation isolation.

The shared-v1 contract suites run the published 0.1.1 reader and compare all six v1 derived tables after replay and rebuild; generation fixtures cover their expanded derived state separately. Privacy and evidence matrices test the core's actual callbacks and sidecar boundaries; model-facing reads, PII turns, staleness checks and capture remain the host's responsibility. Direct person reads remain unscreened. Expiry after a wall-clock rollback retains the existing C05 ceiling: a rebuild can restore a previously expired row until its deadline passes again. A generation can persist exact-entry prune; shared-v1 and unpruned entries retain their existing expiry limitations.

See [the contract and coverage tables](https://github.com/STAIxBWLB/agent-mem/blob/main/docs/contracts.md) for the fixtures, host-owned rows and declared ceilings. These are automated synthetic checks, not proof of the separate multi-machine or managed-agent live legs.


## Generation migration and exact-entry prune

Available from 0.3.0. Do not migrate a memory home that agent-hub also uses until agent-hub pins a generation-capable agent-mem and binds the selected profile (rollout order in [#9](https://github.com/STAIxBWLB/agent-mem/issues/9)); until then a running hub keeps writing shared v1 and the person's notes would split.

Shared v1 remains the default until a person explicitly migrates the memory home. A generation uses `M/generations/G/` and a separate Git repository/ref (`refs/heads/amem/gen/G`); legacy directories and `main` are unchanged. The one-way readonly bridge consumes complete validated legacy prefixes without using the old index or writing legacy notes. Old programs continue using their legacy view, and generation-created notes never flow back to it.

Complete malformed legacy lines (invalid JSON, unknown operations or mismatched content IDs) are skipped and counted, matching shared-v1 handling. Migration dry-run/apply and the person's human CLI status report the skipped count without printing the bodies; JSON list output stays an array of notes. Prefix rewrites, truncation and non-fast-forward legacy history still refuse access. A generation never promotes a bridged note or applies its own settlement to one; only generation-born notes receive generation settlements and promotions.

Generation bridge reads use plain-file snapshots captured during explicit legacy sync and never invoke Git. Unchanged segments use metadata checkpoints without reading or hashing the data, including after reopen. A seeded live handle hashes only the appended suffix, while comparing existing prefix bytes on changed input; the first changed read by a cold handle and an explicit rebuild verify the full prefix. These are read-path bounds, not a latency or speedup promise.

The following interfaces are for a person's terminal and an already initialized synthetic memory home. They do not authorize real-data migration. Use the same current project directory throughout planning and apply:

```sh
AMEM_HOME=/path/to/synthetic-memory amem migrate --dry-run
AMEM_HOME=/path/to/synthetic-memory amem migrate
# If interrupted, resume the recorded generation rather than creating another:
AMEM_HOME=/path/to/synthetic-memory amem migrate --resume
umask 077
AMEM_HOME=/path/to/synthetic-memory amem prune --cutoff 2026-10-01T00:00:00.000Z --dry-run > prune-plan.json
AMEM_HOME=/path/to/synthetic-memory amem prune --apply --plan prune-plan.json
# Explicitly select shared v1 again while preserving both histories:
AMEM_HOME=/path/to/synthetic-memory amem migrate --deactivate
```

All migrate/prune modes, including dry-run, refuse agent markers and require stdin TTY. `--generation <32-hex-G>` selects an explicitly named generation during migration/join; it is never discovered and activated from a remote automatically. Invalid active metadata blocks access rather than silently opening shared v1. Existing handles remain bound to the profile they opened; a selector change does not restart or rebind a running hub.

Explicit `--deactivate` is the recovery path even when the selected generation is corrupt or missing. It reads the selector under the home-wide profile lock, selects shared v1 and retains all generation and legacy data. Normal reads still refuse corrupt active state. Shared-v1 sync keeps its pre-generation Git invocation and caller environment; generation-only sync adds repository-environment isolation and a private child-process umask.

A prune plan is a person-local JSON receipt containing exact target/basis hashes, selector/project/policy revisions, fixed row bytes, local counts and a seal. Apply commits that same receipt after revalidation; it is not an authorization token. Maximums are 256 KiB per plan, 16 rows, 256 targets, and 32 targets/16 KiB per row. Larger automatic selections report `hasMore`; another plan handles remaining targets. Keep redirected plans private and out of source control, model context and sync.

Only explicit serialized expiry is eligible: a note's `expires`, or an exact demote/settle row's `by`. Implicit backstop or instance-TTL deadlines cannot prove prune eligibility. Exact pruned IDs stay unavailable after clock rollback, including get/alias/graph-start paths. A different later promotion or replacement ID remains an independent note; this is not text/family removal, log erasure or storage reclamation. Unpruned expiry still follows the clock.

Standalone CLI prune is local-only, even over a synced target. No `--policy-free` escape enables public prune. A later policy-aware host integration must authenticate intent and attest the exact public payload and current policy revision; only verified public target/basis provenance may sync. Local masks, plans, journals, caches and sidecars never sync. Generation sync refuses public or unknown remote visibility. An interrupted apply resumes the same durable row IDs and exact partial tail; it never rewrites complete lines.

Candidate/counter sidecars are not migrated. `amem review list --kind memory` lists the new machine-local memory candidates under a selected generation; the default legacy review list retains its generation refusal. General memory candidates can be accepted by the person with `review accept --kind memory` into the current project store after current standalone screening; older correction/fail candidates still require profile-aware host integration for generation acceptance.

Real migration remains blocked until the separately reviewed generation-capable amem release and exact-pinned agent-hub integration are installed and their running stores prove the same home/G/selector revision. Synthetic cross-writes and exact prune readbacks precede separately confirmed real migration; known local handles must be quiesced/closed and reopened through the supported session-preserving lifecycle. Release, deployment, real migration, host evidence/capture receipts and real multi-machine sync are not established by these source changes. Deactivation omits generation-only notes/prunes from the v1 view and is not a lossless rollback.

## Curated shard migration (#15 T2)

`amem migrate --shards` moves the curated single home into `projects/<key-hash>/` and `user/` through a resumable generation journal. The original single-home log bytes are never rewritten. A populated selected generation is supported and keeps its generation ID. Each shard keeps private legacy inputs in read-only `legacy/`, public-main inputs in read-only `legacy-main/`, and generation-born rows in its own `log/` and `local/`. It has its own `index.db`, `search.db` and mutation lock; original IDs, hashes, placement and own/local/public provenance are preserved. The source generation bytes stay unchanged. Immutable prune proofs are validated before effects; a multi-shard prune is translated into one deterministic row per shard, with a receipt naming the original row. Existing capture and `work/` directories are not migration inputs and are left untouched. `catalog.db` remains derived and rebuildable, now including curated entry counts and last use. Per-shard sync refs are T3 and are not built.

Before splitting a live home, every installed host must open it through `openShardStore({ project })` or the explicit user shard. Plain `new MemoryStore()` refuses any split marker, including an interrupted split, so it cannot silently keep writing the old layout. No host capability registry currently exists; migration preflight output states that limitation. Do not release T2 for agent-hub use until its memory factory is integrated with `openShardStore` and that host version is installed. Existing unannounced older builds remain the documented unchanged-source ceiling.

Use the same synthetic-home and person-authority boundaries as generation migration:

```sh
AMEM_HOME=/path/to/synthetic-memory amem migrate --shards --dry-run
AMEM_HOME=/path/to/synthetic-memory amem migrate --shards
AMEM_HOME=/path/to/synthetic-memory amem status
# Later old-layout appends are reported by status and carried in idempotently:
AMEM_HOME=/path/to/synthetic-memory amem migrate --resume
```

Every ordinary build that reads the single-home layout holds a cooperating lease in `readers/<pid>-<start-signature>.json`, renewed within 30 seconds and removed on close. Apply and resume refuse a live or unverifiable lease and remove only leases whose pid is confirmed gone. Removed lease filenames and times are recorded in the migration journal and status; registration also refuses while the profile lock is held. Published builds without leases cannot be detected: no process scan proves their absence, and their safety rests only on unchanged legacy bytes. Old-format writers may still append after the split; `amem status` reports those rows and resume carries them into the proper shards. A resume with pending work marks the split incomplete before copying; reads and writes through new or existing shard handles refuse until complete activation. `amem status` then reports the captured phase and pending rows, and `migrate --resume` finishes it idempotently.

Library callers open an already sealed shard directly with `openShardStore({ home, project })` or `openShardStore({ home, user: true })`; these opens do not scan the legacy home or walk the catalog. A project handle reads its own shard plus the user overlay, merging lifecycle metadata before applying visibility; it never reads another project's private text. Shared notes and goals written through a project handle go to `user/`, including their lifecycle operations. Project entries accept only their own project key, while the user shard accepts shared entries. `store.dir` names the selected shard; `store.profile.home` remains the base memory directory. Library callers with a direct base path can use `memoryDir` instead of the historical parent `home` option. Two project shards have independent writer locks, and each incremental index equals its rebuild. `bun scripts/measure-shard-ac8.ts` builds 20 projects and 200,000 entries, poisons the other 19 indexes, and measures open plus ten searches on one shard against the R3 idle/peak RSS limits.

Dry run reports v1, generation-owned/local, prune and translated-prune counts, plus refused relations. A private-to-private replacement across projects refuses before effects. A shared entry superseded by a private entry also refuses: the dry run reports `shared superseded by private: N` and entry IDs only. Un-supersede it, or promote the replacement to shared, then rerun. `ponytail:` supporting that direction requires a body-free lifecycle witness; revisit when a read-only dry run on a copy of the person's home reports a nonzero count, never by probing or migrating the live home here. Private-to-shared replacements remain supported. See [the T2 contract](docs/curated-shard-migration.md).

After a split, ordinary generation `amem migrate` modes (including `--deactivate`) refuse without changing the selector. Use `amem migrate --shards --resume` to finish the split. General memory candidates can be accepted with `review accept --kind memory` into the selected project shard after standalone screening; correction/fail candidates still refuse pending shard-aware host integration. Default `prune` selects the current project's shard; use the person-only `amem prune --user --cutoff <UTC> --dry-run` and `amem prune --user --apply --plan <file>` for shared/user entries. The actor and current-project authorization checks are unchanged.

A native shard crash tail is left to its original writer's recovery. Migration checks planned copy tails and translation-receipt tails before changing activation; matching copies finish append-only and mismatches give an inspection hint. Dangling lifecycle/suggestion metadata is carried as ids-only user data and counted, so a target arriving later retains its intent. Cross-private replacements have their own ids-only count and the un-supersede/promote-to-shared remedy. During interruption the catalog keeps capture information available while `curatedEntries` is `null` and `curatedAvailable` is `false`; its cached capture counts may still lag.

## Session MCP and work lists (#13 P2)

Run `amem mcp` as a stdio child of the agent CLI. It binds the working directory, canonical project key, exact memory home and selected profile once, accepts no project/home overrides in tool arguments, and closes all stores on stdin EOF. It has no listener, daemon, watcher or model call. Ordinary person commands retain their agent-marker refusal and mutation TTY checks; `mcp` is the sole agent entry point.

The frozen nine-tool contract for dotfiles#255 and maru#458:

| Tool | Purpose |
| --- | --- |
| `amem_search` | Screened project search, FTS5/BM25 with tier/recency ranking |
| `amem_show` | Exact or unique-prefix curated note; explicit `capture:<id>` recall |
| `amem_timeline` | Screened notes and labelled capture near an id or time |
| `amem_graph` | Screened curated note neighbourhood, excluding capture and candidate data |
| `amem_work_state_read` | Project work lists, optional closed lists/items |
| `amem_work_state_write` | Append scalar fields, null clears, task selects an item |
| `amem_remember` | General memory candidate only, awaiting person acceptance |
| `amem_vault_candidates` | Read-only screened durable curated notes |
| `amem_capacity` | Numeric machine capacity proposal; no apply capability |

Search/show/timeline label capture as recall with `evidence: false`; capture never enters the curated graph. Policy screens complete rows before selection, limits or graph construction. The standalone secret screen, private flags, PII patterns and deny paths compose with a host's stricter policy through `createMemoryMcp({cwd, base, policy})`. Screening errors fail closed. `base` is the exact memory root; historical library `home` options still name its parent. Scope and profile changes refuse further access instead of silently reopening another store. Reads refuse above 5,000 rows per curated/capture tier; work-list reads use the same 5,000-entry scan ceiling. Count-first admission refuses an oversized work-list corpus before loading or parsing its fields, rather than returning an incomplete screened result. These are operational ceilings, not exposed counts of unscreened data. Graphs cover curated-note relationships, not goal/suggestion tables.

`WorkListStore` writes `projects/<key-hash>/work/` with its own append log, derived index and lock. Scalar fields reduce by latest value, null clears, list status `done` closes, and item status is `todo|doing|done|dropped`. Work lists are outside generation selection and capture eviction. `amem import claude-mem` additionally imports `work_state_entries` only through persisted person-reviewed D2 aliases, preserving source DB bytes and stable replay receipts; JSON keeps observation fields and adds `work` counts/cursor.

`amem vault-candidates --json` and the MCP read tool select durable long-term notes under current policy, excluding task/review/PR/CI progress and already-linked entries. The deterministic status filter covers English status phrases and can miss paraphrased or other-language status text; candidates require person review. No vault is opened, indexed or written. Library `recordVaultLink` records an exact-entry hash and relative Markdown path in a generation-only local append op; it survives index rebuild and shard migration, stays machine-local, and does not change shared-v1 schemas or sync semantics. There is no MCP link writer.

Do not record vault links on a home shared with a host using published agent-mem 0.3.1, including agent-hub while its exact pin stays at 0.3.1. That reader can keep listing from a shared derived index already advanced by the P2 writer, but its next full rebuild refuses the unknown operation. An independent unadvanced index refuses on refresh too. The compatibility fixture omits derived indexes and therefore forces this rebuild refusal on open. Upgrade the sharing host to a pin that includes P2 vault-link support before recording the first link; an ordinary successful list is not rollout readiness. See [the vault-link compatibility contract](docs/contracts.md#generation-only-vault-links).

General memory candidates are separate from curated evidence. `amem review accept <id> --kind memory --policy-free` remains person-only and rechecks the current standalone privacy policy before the accepted note append. Machine capacity reports numeric aggregate use across shards, as R7 requires; it does not return foreign project names or text.

`bun scripts/measure-mcp-budget.ts` exercises an actual stdio session with 200 curated notes, 2,000 capture rows and 2,000 work-list operations reduced into 100 items. It checks the R3 idle RSS limit of 100 MB, peak RSS limit of 200 MB across searches and work-list reads, and child reaping after EOF. CI runs the harness on macOS and Linux. All harness data is synthetic; live P6 measurements remain separate.

## Development

```sh
bun install --frozen-lockfile
bun x tsc --noEmit
bun scripts/check-boundary.ts
bun test
npm pack --dry-run
```

CI runs the typecheck, boundary check and tests on Ubuntu and macOS with Bun 1.4.2. Tests use synthetic fixtures and isolated homes, not personal memory stores.

## Publishing

0.1.0 was published once by hand, because npm trusted publishing requires an existing package; the trusted publisher for repository `STAIxBWLB/agent-mem` and workflow `release.yml` was configured after it. Every later release goes through the tag workflow.

After setup, a `v*` tag triggers both operating-system gates. The tag must equal `v` plus `package.json`'s version. Only after both gates pass does the release job install npm 11.20.0 (trusted publishing needs 11.5.1 or later) and run `npm publish --access public`, authenticated through GitHub OIDC with `id-token: write`; npm adds provenance itself. The workflow uses no `NPM_TOKEN`.

License: MIT.
