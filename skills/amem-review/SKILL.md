---
name: amem-review
description: Review and consolidate amem candidates, recheck notes and prepare scoped promotion.
---

# amem review

Read `references/amem-adapter.md`; when running from a checkout or plugin source, fall back to `../_shared/amem-adapter.md`.

- Run `amem consolidate --json` to queue deterministic project-local candidates, including eligible recent capture records. Candidates are not evidence or curated notes.
- Inspect `amem review list --json`, then use the full candidate ID with `amem review decide <id> accept|reject|defer --json`. Inspect the preview, including `overlaps` and `originRecheck`, before repeating the decision with `--confirm`. Alternatively use `amem review walk` in a terminal.
- Use `amem review targets --json` for recheck priorities and `amem decay --propose` to queue unused-injection candidates. `amem decay --apply` previews exact revisions; add `--confirm` only after review. `amem dedupe` previews reconciliation; `--apply` writes it.
- For repository promotion, preview `amem promote <id> --to repo`, inspect the screened line and repository visibility, then add `--confirm`; a public or unverified repository also needs `--confirm-public` and the ID prefix. Use `amem repo status` and preview `amem repo attributes` before `--confirm`.
- Use `amem_vault_candidates` or `amem vault-candidates` to list candidates and hand off selected material to the vault workflow; listing alone does not promote it.
