# agent-mem

Curated memory with append-only JSONL logs, a derived SQLite index, short- and long-term tiers, a typed graph, goals with leases, and git sync between machines. Extracted from [agent-hub](https://github.com/STAIxBWLB/agent-hub), with compatible storage and entry IDs.

Status: initial package extraction. `@staix/agent-mem` has not been published yet. Requires Bun 1.4.2 or later; no runtime dependencies.

## Install

After the first publication:

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

The entry point exports the store, types and identity helpers, sync and claude-mem import, project/home helpers, raw memory/goal command handlers, and platform helpers. Hosts inject their own privacy policy through `StoreOptions.screen`; CLI wrappers can supply screened reads and import policy through the raw command options.

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

The first publication is the person's responsibility. npm trusted publishing requires an existing package: first publish `@staix/agent-mem` manually, then configure its GitHub Actions trusted publisher for repository `STAIxBWLB/agent-mem` and workflow `release.yml`. No publication is performed by this extraction task.

After setup, a `v*` tag triggers both operating-system gates. The tag must equal `v` plus `package.json`'s version. Only after both gates pass does the release job run `npm publish --provenance --access public`, authenticated through GitHub OIDC with `id-token: write`. The workflow uses no `NPM_TOKEN`.

License: MIT.
