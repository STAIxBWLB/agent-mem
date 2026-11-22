---
name: amem-ops
description: Maintain amem capture, storage, sync, migration and evaluation workflows.
---

# amem operations

Read `references/amem-adapter.md`; when running from a checkout or plugin source, fall back to `../_shared/amem-adapter.md`.

- For transcript intake use `amem ingest <codex|kimi|pi|qwen> --json`, optionally with `--since`. For spool recovery save the `amem spool replay --json` preview and apply that exact plan with `--apply --plan` after inspection.
- Inspect `amem capacity`, `amem projects` and `amem usage` before capacity or shard maintenance. `amem capacity apply` and `amem capacity apply --split` preview first and require matching `--confirm`; `amem gc` also previews before `--confirm` and supports `--batches`.
- Use `amem alias` to inspect or manage explicit project aliases. `amem project export`, `amem project import`, `amem project archive`, `amem project unarchive` and `amem project forget` handle project lifecycle; import and forget require their preview and `--confirm`. External sources use `amem import claude-mem`, `amem import claude-auto` or `amem import codex` under current policy.
- Preview `amem formats raise` before `--confirm`, and inspect known writers before raising a floor. Use `amem sync` for configured private sync. For migrations use `amem migrate --shards`, `amem migrate --public-prune-view` or `amem migrate --sync-placement`; inspect the preview and applicable plan and writer requirements before any apply.
- For durable expiry save a sealed plan with `amem prune --dry-run --cutoff <UTC> --json`, then apply that plan with `amem prune --apply --plan <file>` in the same project. Do not substitute a human-readable preview for the plan.
- Use `amem eval` for recall evaluation and `amem eval audit sample` and `amem eval audit score` for a separate evidence audit. For leaked entries use `amem forget <id>` and follow `docs/purge.md` for the remaining copies.
