# Changelog

## 0.1.1

- First release through the tag workflow with npm trusted publishing (OIDC) and provenance; pins npm 11.20.0 in the release job.
- New subpath export `@staix/agent-mem/platform` (deny list, hardened git, realPath, process identity): it imports only `node:` built-ins, so Node hosts can load it; the root entry loads `bun:sqlite` and needs Bun.

## 0.1.0

- Initial standalone `@staix/agent-mem` library and person-only `amem` CLI.
- Compatible append-only memory storage, derived SQLite index, tiers, graph, goals and private git sync.
- Static zsh, bash and fish completion from shared CLI definitions.
- Agent-session refusal, terminal-only mutations and explicit `--policy-free` boundary acknowledgement.
- Synthetic agent-hub 0.12.29 output parity fixtures and portable core regressions.
