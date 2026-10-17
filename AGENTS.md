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

## Scope and sessions

- amem is developed together with agent-hub from agent-hub sessions (`../agent-hub`). Standalone-only features may be developed in a session started here. Publish a change the hub consumes first; the hub then raises its exact pin in its own PR.
- Keep amem usable without agent-hub and without claude-mem: never import agent-hub code or call the claude-mem worker. Host behavior (privacy policy, inference) enters only through the library API. Plan and budgets: #13.
- Never add a resident process (daemon, watcher, launchd agent) or a model or network call on the capture path. Add no embeddings or vector index until #13 AC4 evidence and an owner decision allow them, and then only opt-in and computed on demand (none in #13 P1-P5). The #13 resource budgets are acceptance criteria. Observed 2026-10-17: claude-mem's Chroma held 4.0 GB RSS for 11 h and blocked heavy-job admission.

## agent-hub coordination

- Work assigned on the agent-hub board runs from an agent-hub session (`../agent-hub`), and that repo's `AGENTS.md` §agent-hub binds it, including when a pull-only session reads `hub_inbox`. A session started in this directory has no hub: do not run `ahub up` or `ahub init` here.

## Releasing

- Publish only through the `v*` tag workflow. Before tagging, write the version's `## <version>` section in `CHANGELOG.md`: the workflow checks it before `npm publish` and its `release-notes` job publishes it as the GitHub Release body. Observed: 0.1.1-0.3.0 had no GitHub Releases until 2026-10-17.
- After the release, read back the published version with a cache-busting registry request (not `npm view`) and read back the Release body.

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
