---
name: amem-status
description: Diagnose amem installation, capture, storage and sync health in a read-only report. Use when asked to check amem health, setup drift, capture freshness or sync status.
---

# amem status

Read `references/amem-adapter.md`; when running from a checkout or plugin source, fall back to `../_shared/amem-adapter.md`.

- Compare `amem --version` with the installed `.amem-skill.json` version and inspect `which -a amem` for PATH collisions. Report missing markers or commands as unavailable, not healthy.
- Run `amem status --json`, `amem doctor --json`, `amem capacity --json` and `amem sync --status --json`. Summarize resolved home, generation and shard migration, pending candidates and expiry warnings, capture freshness and drops, brief token cost, index comparison, reader leases, policy, setup drift and placement writer verification when present. Report unavailable checks and errors explicitly.
- Group findings by urgency and provide at most one highest-priority repair command at the end. Do not execute a repair in this skill.
