# agent-mem

Curated memory with append-only JSONL logs, a derived SQLite index, short- and long-term tiers, a typed graph, goals with leases, and git sync between machines. Extracted from [agent-hub](https://github.com/STAIxBWLB/agent-hub), with compatible storage and entry IDs.

Version: 0.2.0. Requires Bun 1.4.2 or later; no runtime dependencies.

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

Memory commands: `list`, `search`, `show`, `graph`, `suggestions`, `confirm`, `reject`, `promote`, `demote`, `forget`, `supersede`, `rebuild`, `dedupe`, `sync`, `machine`, and `import`. Use `--json` where supported by the corresponding `ahub memory` command. `dedupe` previews candidates; `dedupe --apply` appends reconciliation operations.

`amem` is for the person. Every command is refused when an agent-session marker is present, including `AGENTHUB_PEER_ID`, `CLAUDECODE`, and `CODEX_THREAD_ID`. Agents read memory through the hub's `hub_memory_*` tools. Environment-marker detection is an honest-session guard, not authentication. Mutating commands also require a TTY on stdin.

This package does not ship the host's privacy policy. Person reads show stored data without screening. Import and promotion retain the built-in secret screen. Commands that cross the privacy boundary require the person's explicit `--policy-free` choice:

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

Shared segments retain the `agent-hub.memory/v1` profile. `OP_CONTRACTS` and `V1_OPS` keep the shared-v1 operation contract; both shared append paths refuse unknown or truth-changing operations. The separate `GENERATION_OP_CONTRACTS` enables only `prune` after an explicit generation selection. `correct`, `lift`, `consolidate` and `group` remain blocked. Reader announcements cannot authorize a new operation or relax generation isolation.

The shared-v1 contract suites run the published 0.1.1 reader and compare all six v1 derived tables after replay and rebuild; generation fixtures cover their expanded derived state separately. Privacy and evidence matrices test the core's actual callbacks and sidecar boundaries; model-facing reads, PII turns, staleness checks and capture remain the host's responsibility. Direct person reads remain unscreened. Expiry after a wall-clock rollback retains the existing C05 ceiling: a rebuild can restore a previously expired row until its deadline passes again. A generation can persist exact-entry prune; shared-v1 and unpruned entries retain their existing expiry limitations.

See [the contract and coverage tables](https://github.com/STAIxBWLB/agent-mem/blob/main/docs/contracts.md) for the fixtures, host-owned rows and declared ceilings. These are automated synthetic checks, not proof of the separate multi-machine or managed-agent live legs.


## Generation migration and exact-entry prune (unreleased)

This section describes the generation-capable development build, not the published 0.2.0 package.

Shared v1 remains the default until a person explicitly migrates the memory home. A generation uses `M/generations/G/` and a separate Git repository/ref (`refs/heads/amem/gen/G`); legacy directories and `main` are unchanged. The one-way readonly bridge consumes complete validated legacy prefixes without using the old index or writing legacy notes. Old programs continue using their legacy view, and generation-created notes never flow back to it.

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

A prune plan is a person-local JSON receipt containing exact target/basis hashes, selector/project/policy revisions, fixed row bytes, local counts and a seal. Apply commits that same receipt after revalidation; it is not an authorization token. Maximums are 256 KiB per plan, 16 rows, 256 targets, and 32 targets/16 KiB per row. Larger automatic selections report `hasMore`; another plan handles remaining targets. Keep redirected plans private and out of source control, model context and sync.

Only explicit serialized expiry is eligible: a note's `expires`, or an exact demote/settle row's `by`. Implicit backstop or instance-TTL deadlines cannot prove prune eligibility. Exact pruned IDs stay unavailable after clock rollback, including get/alias/graph-start paths. A different later promotion or replacement ID remains an independent note; this is not text/family removal, log erasure or storage reclamation. Unpruned expiry still follows the clock.

Standalone CLI prune is local-only, even over a synced target. No `--policy-free` escape enables public prune. A later policy-aware host integration must authenticate intent and attest the exact public payload and current policy revision; only verified public target/basis provenance may sync. Local masks, plans, journals, caches and sidecars never sync. Generation sync refuses public or unknown remote visibility. An interrupted apply resumes the same durable row IDs and exact partial tail; it never rewrites complete lines.

Candidate/counter sidecars are not migrated. `amem review` currently refuses a selected generation rather than using an unbound legacy sidecar. A profile-aware host integration must handle that context explicitly.

Real migration remains blocked until the separately reviewed generation-capable amem release and exact-pinned agent-hub integration are installed and their running stores prove the same home/G/selector revision. Synthetic cross-writes and exact prune readbacks precede separately confirmed real migration; known local handles must be quiesced/closed and reopened through the supported session-preserving lifecycle. Release, deployment, real migration, host evidence/capture receipts and real multi-machine sync are not established by these source changes. Deactivation omits generation-only notes/prunes from the v1 view and is not a lossless rollback.

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
