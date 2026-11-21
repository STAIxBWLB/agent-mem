# Development and publishing

Moved from the README (#514). The [README](../README.md) keeps the overview and links.

## Development

```sh
bun install --frozen-lockfile
bun x tsc --noEmit
bun scripts/check-boundary.ts
bun scripts/readme-facts.ts     # README blocks between <!-- facts:<name> --> markers; --write regenerates them
bun scripts/check-docs.ts     # review stamps in docs/verified.json; stale documents are warnings
bun test
npm pack --dry-run
```

CI runs the typecheck, boundary check, README facts and documentation stamp checks and tests on Ubuntu and macOS with Bun 1.4.4. Tests use synthetic fixtures and isolated homes, not personal memory stores.

The agent rule for local checks (#502) is in `AGENTS.md`; its rationale is in [agents-background.md](agents-background.md#commands-and-verification).

## Host API fixture

The v1 host API signature fixture records the TypeScript version that generated it. When TypeScript changes, regenerate it from the repository root with:

```sh
bun test/fixtures/host-api-v1/generate.ts > test/fixtures/host-api-v1/signatures.json
```

Diff and review the result against the frozen v1 contract before committing. Removing or narrowing a member, or changing a closed enum, requires a host API version raise rather than regeneration. The signature check is conservative and may also flag compatible additions for review.

## Publishing

0.1.0 was published once by hand, because npm trusted publishing requires an existing package; the trusted publisher for repository `STAIxBWLB/agent-mem` and workflow `release.yml` was configured after it. Every later release goes through the tag workflow.

After setup, a `v*` tag first proves that the identical whole Git tree already has a successful same-repository `check` run with both OS gates; it does not rerun the test shards. Matching active CI is awaited within 25 minutes. The release then runs its two-OS version, main-ancestry, CHANGELOG, manifest, typecheck, boundary, README-facts, documentation-freshness and pack gates. The tag must equal `v` plus `package.json`'s version. Only after both gates pass does the release job install npm 11.20.0 (trusted publishing needs 11.5.1 or later) and run `npm publish --access public`, authenticated through GitHub OIDC with `id-token: write`; npm adds provenance itself. The workflow uses no `NPM_TOKEN`. Release checkouts pin the proven commit, and the tag object is rechecked before publication and Release edits. Manual release dispatch is proof-only and cannot publish; the [release reuse contract](contracts.md#release-gate-reuse-302) states the last-read ceiling. The gates also refuse a stale documentation stamp (`bun scripts/check-docs.ts --require-fresh`). After the GitHub Release, a separate job sends a `repository_dispatch` to STAIxBWLB/agent-hub-site so its portal re-syncs; it is skipped without the `SITE_DISPATCH_TOKEN` secret and its failure does not fail the release.
