---
name: amem-recall
description: Recall and verify project memory, evidence and historical context. Use when looking up prior project decisions, failures or evidence before or during work.
---

# amem recall

Read `references/amem-adapter.md`; when running from a checkout or plugin source, fall back to `../_shared/amem-adapter.md`.

- Before work, call `amem_brief` with intent and relevant paths and symbols, or run `amem brief --for <intent> --paths <path> --symbols <symbol>`. Read fail guards and verify their applicability to the current checkout.
- For a question, use `amem_evidence` for a bounded cited bundle and `amem_search` for project recall. Search results can include capture, which is not curated evidence. Cite the note IDs and verify claims against current sources.
- Inspect a note or capture with `amem_show` or `amem show <id>`; use `amem_graph` for curated relationships and `amem_timeline` for surrounding events. Timeline groups consecutive capture calls as `capture-run`; set `expand: true` when individual calls matter.
- For historical CLI reads use `--history` or `--as-of` where supported. Use `amem search --all-projects` only when the question crosses projects; label that scope. Check `staleReason` values such as `missing_in_checkout` and `mtime_newer_than_note` against the checkout before relying on a note.
