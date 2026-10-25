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

- Develop amem from this repository's own hub; coordinate a change agent-hub consumes from an agent-hub session (`../agent-hub`). Publish that change first; the hub then raises its exact pin in its own PR.
- Keep amem usable without agent-hub and without claude-mem: never import agent-hub code or call the claude-mem worker. Host behavior (privacy policy, inference) enters only through the library API. Plan and budgets: #13.
- Never add a resident process (daemon, watcher, launchd agent) or a model or network call on the capture path. Add no embeddings or vector index until #13 AC4 evidence and an owner decision allow them, and then only opt-in and computed on demand (none in #13 P1-P5). The #13 resource budgets are acceptance criteria. Observed 2026-10-17: claude-mem's Chroma held 4.0 GB RSS for 11 h and blocked heavy-job admission.

## agent-hub coordination

- This repository runs its own hub from its real path `dev/agent-mem/`. Work on its board runs from a session started here, and the `AGENT_HUB` marker block that `ahub init` adds to this file binds it. Owner decision 2026-10-25.
- The person runs `ahub init` and `ahub up` in a terminal outside any agent session; the CLI refuses agent shells.
- Work assigned on the agent-hub board runs from an agent-hub session (`../agent-hub`) under that repo's `AGENTS.md` §agent-hub, including when a pull-only session reads `hub_inbox`.

## Merging

- The reviewer that approves a PR with `hub_review` at its head merges it with `gh pr merge <pr> --squash --match-head-commit <head>` once `check (ubuntu-latest)` and `check (macos-latest)` pass on that head, no review thread is unresolved, no bot review (codex-connector included) is pending or running and no change request is pending; it then deletes the remote branch (`delete_branch_on_merge` is off here) and removes the worktree. If a gate is open, it names the gate instead of merging. Never `--admin`. Owner decision 2026-10-25, agent-hub#786.
- Merging is not releasing: tagging and publishing still need the person's explicit authorization (Releasing below).

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

- Refuse ordinary CLI commands in agent-marked sessions, except a lone `--help` or `--version` (the usage text and the version carry no data and no mutation). `amem mcp` writes only candidates and work lists; `amem hook <event>` and `amem ingest <codex|kimi|pi>` append only capture rows; none writes curated notes or goals. Keep ordinary CLI mutations person-only and require stdin TTY. Hooks never deny, replace a tool call or perform network/model work.
- Promote, import, sync, review accept and project export apply the configured standalone policy (`amem.config.json` in the memory home, narrowed only by a repository's `.amem/config`; secrets, personal data, PII patterns, deny paths) instead of requiring `--policy-free` (agent-mem#40 F4). The flag is still accepted and means nothing more, so it never bypasses the screen, and sync screens the rows it would actually publish. Keep host privacy policy out of this package; ordinary person reads are unscreened, vault-candidate listings use current policy, and import/promotion retain the secret screen.
- Resolve data storage with `memoryHome()`: `AMEM_HOME`, then the `home` pointer in the `amem.config.json` that sits in the default home (`$AGENTHUB_HOME/memory`, else `~/.agenthub/memory`; a pointer only, the policy keys live in the file inside the home it names), then that default home itself. Keep tests isolated through `test/home.ts`.

## Things agents get wrong

- For the extraction contract (2026-10-16, recheck when changing storage or host integration), preserve schema/hash/path compatibility with existing agent-hub stores; do not rename the schema to match this package.
- For CLI authorization (2026-10-16, recheck when changing CLI entry points), agent environment markers are an honest-session refusal, not authentication; never offer bypass instructions or widen hub sandbox permissions.
- For vault-link authoring (2026-10-18, recheck before authoring or a host-pin change), require every host sharing that memory home to include P2 vault-link support. Do not record links while a sharing agent-hub still pins agent-mem 0.3.1; compatibility details: `docs/contracts.md` §Generation-only vault links.
- Never write `close`, `closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves` or `resolved` directly before an issue reference (`#N`, `owner/repo#N`) in a PR title, body or commit message unless that PR should close the issue, negations included: GitHub reads `close #15` inside "Does not close #15" as a closing keyword. Write "stays open" or "Refs #N". Observed 2026-10-24: PR #36 closed the shard design issue (#15) while T3 was open. agent-hub's `closing-refs` workflow checks its own PRs; this repository relies on the rule.
