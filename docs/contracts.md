# Shared-v1 contracts

P8 keeps the shared `agent-hub.memory/v1` profile. The schema string, content hashes, segment format and reducers stay unchanged. `src/memory/ops-contract.ts` declares the current operation vocabulary and the reserved truth-changing operations. `MemoryStore.appendBody` and the separate `importNote` append path refuse unknown or truth-changing operations before appending bytes. This is a writer boundary, not validation of externally edited segments. Older/raw writers remain outside this version's mutation lock.

A future truth-changing operation requires a person-run generation migration and its payload/reducer contracts first. No reader inventory, announcement or successful compatibility check permits it in shared-v1 segments. P8 introduces no generation writer, reader announcements or new operation payload.

## Operation table

All implemented payload schemas have version 1 and retain canonical full-payload hashing, including schema, timestamp and machine. Full entry IDs are immutable targets, except the existing task-key and relation encodings shown below. The registry records exact fields, precedence, placement and crash boundaries; fixtures are in `test/contract/fixtures.ts`.

| Operation | C1 profile | C2 contract and fixture | C3/C4 coverage |
| --- | --- | --- | --- |
| note | v1-equal | `v1-note`; tier placement, full payload identity, supersession and expiry | readable callback, promotion, import; list/search/show/rebuild |
| forget | v1-equal | `v1-forget`; target segment, forget wins regardless of timestamp | ordinary derived views exclude forgotten notes |
| supersede | v1-equal | `v1-supersede`; old target placement, immutable replacement, ordering/cycles | ordinary views and explicit person candidate acceptance |
| demote | v1-equal | `v1-demote`; fixed deadline, latest timestamp/id | derived view expiry; C05 ceiling below |
| settle | v1-equal | `v1-settle`; local task key, earliest deadline | held-note projection; C05 ceiling below |
| goal | v1-equal | `v1-goal`; synced immutable goal and dependency IDs | not a candidate/counter note path |
| goal_state | v1-equal | `v1-goal_state`; latest timestamp/id | authored goal projection only |
| goal_link | v1-equal | `v1-goal_link`; immutable task key | authored goal projection only |
| lease | v1-equal | `v1-lease`; per-machine claims, expiry and conflict ordering | authored lease metadata only |
| lease_force | v1-equal | `v1-lease_force`; last force resets preceding claims | authored lease metadata only |
| suggest | v1-equal | `v1-suggest`; immutable source and relation/destination | raw graph labels suggestions; evidence retrieval excludes them |
| confirm | v1-equal | `v1-confirm`; latest verdict timestamp/id | explicit person action enables valid suggested relationship |
| reject | v1-equal | `v1-reject`; latest verdict timestamp/id | rejected relationship excluded from evidence |
| prune | truth-changing, no writer | `deny-prune`; refused before append | no payload, no new evidence |
| correct | truth-changing, no writer | `deny-correct`; refused before append | correction candidates remain sidecar proposals; acceptance uses note/supersede |
| lift | truth-changing, no writer | `deny-lift`; refused before append | no payload, no new evidence |
| consolidate | truth-changing, no writer | `deny-consolidate`; refused before append | no payload, no new evidence |
| group | truth-changing, no writer | `deny-group`; refused before append | no payload, no new evidence |

The published `@staix/agent-mem@0.1.1` reader is pinned as a development-only alias. `legacy-reader.test.ts` tests four counterexamples against independently authored expected visible notes: an unannounced read-only reader, old/new stores sharing a machine segment, an offline machine starting its old reader later, and an old reader launched after the compatibility check. A further fixture invokes all 13 current operation writers through public MemoryStore APIs, asserts each complete emitted payload and local/synced placement, and transfers only the emitted log bytes to a separate legacy index. After every write it compares list/get/goal/suggestions/graph projections; independent lifecycle assertions cover forgetting, supersession, expiry, goals, leases and person verdicts. Local target branches for demote/supersede/forget are also checked. These are real reader fixtures, not live multi-machine sync receipts.

`test/contract/replay.ts` compares every derived table (`entries`, `ops`, `edges`, `goals`, `heads`, `segments`) with `rebuild()`, including offsets and hashes. Every current operation needs a declared schema and golden fixture. Permuted segments, duplicate events, incomplete tails, complete appends without index refresh, interrupted multi-write sequences and explicit reducer expectations are retained. A missing contract or fixture fails the suite; reserved operations have deny-only fixtures and no invented future schema.

C05 remains a declared ceiling: expiry removes derived rows using the wall clock without a durable prune operation. Moving the clock backward can leave the incremental index empty while a rebuild restores the authored row and its edges. The clock-rollback fixture asserts this exact divergence, unchanged authored bytes and stable subsequent rebuilds. It does not claim universal incremental/rebuild equality across backward time. A durable prune contract belongs to P9 and would require migration before a new truth-changing operation.

## Privacy matrix (C3)

`test/contract/coverage.ts` names each core test and each host-owned row. The package does not infer PII or authenticate a caller-supplied privacy verdict.

| Surface | Core test | Boundary and limit |
| --- | --- | --- |
| raw command list/search/show | every actual View field reaches `readable`; withheld rows are absent | host supplies policy; metadata and lifecycle fields are included |
| direct list/search/get and raw graph | explicit unscreened-read fixture | person-facing API; raw graph does not call `readable` |
| promotion screen | private marker in title/text/peer/project/task/about | `StoreOptions.screen` is promotion-only, not a general read/write policy |
| claude-mem import | marker and secret in title/body/narrative; source bytes unchanged | arbitrary source metadata needs host output screening |
| candidates | private/PII/unknown verdict rejects each valid contextual or payload field | full target IDs remain opaque validated identities; a public verdict is host-authenticated input |
| counters | private/PII/unknown verdict rejects project/task/turn/session/delivery context | observed zero differs from unknown; entry IDs remain opaque |
| sync | local synthetic remote excludes candidate/counter sidecar and proposal text | ordinary v1 note logs are intentionally synced, not a blanket PII filter |
| read tools, recall, brief, ask, staleness, capture, PII turns | agent-hub tests, not core proof | query/title/text/nodes/edges/errors/counts, context and private-path probes are host-owned |

## Evidence matrix (C4)

`evidence-matrix.test.ts` has a separate fixture for each core consumer: list, search, get/show, graph/related, import, sync and rebuild. Candidate/counter IDs and proposal text do not become ordinary notes or graph evidence. The sidecar is not a valid claude-mem source; provenance-marked model answers are skipped. An importer cannot identify externally relabeled model output whose provenance was discarded.

Raw graph intentionally exposes unconfirmed suggestions for dashed presentation. `related()` excludes them until a person confirms; raw graph is not itself an evidence-only projection. V1 suggestion operations may sync, while the machine-local sidecar does not. Explicit authenticated person acceptance plus current host policy can append ordinary v1 notes/supersession; an actor string alone is not authentication. Brief, ask, recall and capture consumer tests remain in agent-hub. No live account, managed-agent or multi-machine acceptance is claimed here.
