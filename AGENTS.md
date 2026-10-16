# agent-mem

## Commands and verification

- Install with `bun install` (Bun 1.4.2).
- Before reporting completion, run `bun x tsc --noEmit`, `bun scripts/check-boundary.ts`, `bun test` and `npm pack --dry-run`; report their results. Boundary success prints `boundary: OK`.
- Run one focused file with `bun test test/<name>.test.ts`.
- Keep one heavy job per repository, including its worktrees.

## Conventions and structure

- Keep zero runtime dependencies. `src/` imports only Node built-ins, `bun:sqlite`, and relative files within `src/`; run the boundary check after changes.
- Keep TypeScript strict with `noUncheckedIndexedAccess` and explicit `.ts` relative import extensions.
- Put library exports in `src/index.ts`, person-facing argument and identity checks in `src/cli.ts`, and portable memory implementation in `src/memory/`.
- Add a `ponytail:` comment naming the ceiling and upgrade path for deliberate shortcuts.
- Work on a branch; use conventional English commit messages. Do not publish without explicit authorization.

## Storage invariants

- Preserve `agent-hub.memory/v1` inside the entryId hash, canonical JSON, full-prefix hashing, kinds, scopes and ops.
- Preserve segment, `machine.json` and `sync.lock` paths.
- Never rewrite a log line. Express every change as a new entry.
- Keep `index.db` derived only from rows; incremental indexing must equal a full rebuild. Retain the golden regression.
- Resolve paths through `realPath` in `src/memory/platform.ts`, not direct `realpathSync` calls; preserve the Bun backslash-path workaround.
- Keep deny, hardened git and process identity implementations single-sourced in `src/memory/platform.ts`.

## CLI and policy boundaries

- Refuse every CLI command in an agent-marked session; agents use the hub's `hub_memory_*` tools. Require stdin TTY for mutations.
- Require explicit `--policy-free` for promote, import and sync. Keep host privacy policy out of this package; person reads are unscreened and import/promotion retain the secret screen.
- Resolve data storage with `memoryHome()`: `AMEM_HOME`, then `$AGENTHUB_HOME/memory`, then `~/.agenthub/memory`. Keep tests isolated through `test/home.ts`.

## Things agents get wrong

- For the extraction contract (2026-10-16, recheck when changing storage or host integration), preserve schema/hash/path compatibility with existing agent-hub stores; do not rename the schema to match this package.
- For CLI authorization (2026-10-16, recheck when changing CLI entry points), agent environment markers are an honest-session refusal, not authentication; never offer bypass instructions or widen hub sandbox permissions.
