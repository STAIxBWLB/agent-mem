---
name: amem-remember
description: Propose project memory, record curated notes and maintain amem work lists and goals.
---

# amem remember

Read `references/amem-adapter.md`; when running from a checkout or plugin source, fall back to `../_shared/amem-adapter.md`.

- Choose a specific kind: decision, contract, finding, fail or preference. Anchor decisions, contracts and findings to relevant repository paths. A fail needs `approach`, `symptom`, `cause`, `evidenceRefs` and `retryWhen`; record what would justify retrying. A preference requires a compatible `curated` or `home` format floor of at least 0.25.0.
- Use `amem_remember` to propose a candidate and inspect `overlaps`. Use `amem_correct` to propose a correction bound to the current target revision. Neither tool writes a curated note; review through the CLI.
- For an authorized direct curated note use `amem note add`; its fail fields are `--approach`, `--symptom`, `--cause`, repeatable `--evidence` and `--retry-when`. `amem supersede <old-id> <new-id>` connects an existing replacement to its predecessor. The configured policy applies.
- Use `amem_work_state_read` and `amem_work_state_write` for project lists. For goals use `amem goal list`, `amem goal show`, `amem goal new`, `amem goal state`, `amem goal done` or `amem goal take` as appropriate.
