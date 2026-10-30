# Generation-neutral public prune witnesses

Approved design contract for agent-mem#15 T3, agent-hub task 404. Claude read the full note at 191744e2 and approved D01-D03 on 2026-10-30; the disposition is recorded below. Source inspected at `1c3846931d415c31bb1b6f4166ae91fff06de5e7` (0.13.0). No implementation, schema activation, migration or AC4 completion is claimed. The amendment in docs/contracts.md makes this the normative target for the follow-up implementation; current 0.13.0 behavior below remains the shipped baseline.

## Problem and current boundary

A prune's identity includes its source generation. Replacing that generation with the receiver's generation changes the ID. A transported ordinary entry can retain its ID across independently initialized generations, but inserting the original foreign prune into the receiver's native generation log fails the native generation check. Retagging, dropping the row or re-authoring it as a receiver-person prune is not an acceptable solution.

The old task description's blanket foreign-prune transport refusal is historical. Current 0.13.0 already:

- preserves complete original ordinary rows and verified foreign prune payloads in content-addressed per-realm transport packs;
- validates complete public target/basis proof against each prune's original generation before selected publication/import;
- installs durable private foreign holds before importing selected ordinary/native rows;
- reports held foreign targets as possibly still visible; holds are transport history, never native tombstones or rebuild inputs.

Thus the remaining gap is **generation-neutral application with replayable public evidence**, not permission to transport an unverified row. Current invalid/missing proof still refuses before publication/import. `docs/contracts.md:355-361`, `shard-sync.ts:134-159,177-198,249-281` and `generation-index.ts:130-164` define that distinction.

## Existing identities and proof rules that do not change

| Object | Existing rule |
| --- | --- |
| Entry | `agent-hub.memory/v1`, existing canonical body/entryId rules and full source attribution; no new field or shared-v1 op |
| PruneRow | `agent-mem.prune/v1`; SHA-256 of the complete canonical body excluding only id, truncated to 32 hex characters, includes generation/at/machine/actor/placement/cutoff/targets |
| Prune payload hash | Full 64-hex hash of the canonical complete row, including its ID |
| Target/basis row hash | Full 64-hex hash of the canonical complete Entry, including its ID; entryId alone is not rowHash |
| Generation/machine | Existing 32-hex generation and 16-hex machine identifiers, not a receiver-created replacement |
| Expiry | Explicit serialized expires/by deadline from exact note/demote/settle relation; no implicit TTL, current clock or supersession traversal |
| Public witness | Proven source occurrence with synced placement; never inferred from placement alone, a public:true flag or an outgoing selection |
| Scope | Every target and basis proved inside its physical project/user realm; no witness borrowed from another selected realm, unopened project, alias, machine/local source or private source |

`prune.ts:63-125` remains the reference validator/reducer. Actor strings retain attribution and are not authentication. The existing host authorization and positively private owned Git transport are not replaced with a hash, receipt flag or claimed person field.

A native generation/log occurrence or validated immutable legacy-main occurrence can supply the current source's public provenance; legacy-local/log may have synced placement without publicWitness. A verified fetched occurrence can establish public provenance. An unwitnessed legacy original already pruned locally must never be first-published to manufacture a witness. Preserve `coalesceGenerationSource` and `sourceRows` semantics.

## Proposed contract and eligibility

The proposed design separates three things:

- the unchanged authored/transported PruneRow;
- a generation-neutral manifest identifying complete same-realm public witness occurrences;
- receiver-local durable input and derived masks, with no receiver-authored prune operation.

For an eligible row, the receiver validates the original generation and full payload, then derives a mask of exact target Entry IDs under its own profile. It does not require a directory for the source generation, retag the prune, append it to a foreign-author native log, or mark it as authored by the receiving machine.

Initial eligibility is deliberately strict:

- the complete original PruneRow is present, canonical, synced, valid under its own generation and within current prune bounds;
- every original target and expiry basis is in one permitted physical realm, and every full row/hash/expiry/public occurrence can be proved there;
- the selected profile and transport explicitly support this input/reducer version;
- required original/translation identity provenance is available under the definition agreed in D01 below.

This includes independently initialized generations and immutable migrated legacy **ordinary** targets/bases when they have valid public proof. It does not treat legacy placement as proof, infer a source generation from local state, or accept a target subset as a complete original prune.

## Decided D01: conservative single-realm eligibility (2026-10-30)

Current `shard-migration.ts:267-277` splits a prune across destinations. One group keeps the input row; several groups get subset payloads and newly computed IDs, plus sourceId/sourceHash translation metadata. A canonical transported subset may therefore already differ from the pre-migration authored prune.

Three requirements cannot be satisfied merely by adding sourceId:

- preserve the original complete plain-hash identity;
- reveal no unopened-realm target IDs or private witnesses;
- independently recompute/validate the complete original from a selected-realm subset.

A subset does not determine the original SHA-256 payload. Exporting the full original can reveal outside-realm IDs; importing other realms' bodies to prove it violates realm ownership. A self-hashed or publisher-asserted mapping is not a membership proof.

Claude, planner and reviewer of task 404, accepted this conservative ceiling on 2026-10-30:

- Define separately original transported row ID, pre-migration authored source ID and any already-existing translated ID. Never label one as the other or regenerate either during sync.
- A neutral witness keeps the full original row and same-realm public target and basis proofs; the derived local mask stays separate from native PruneRows. A prune is eligible only when all original targets are in one authorized physical realm. Migrated immutable legacy targets remain eligible when their public occurrences are verified. Preserve available original/translation evidence unchanged.
- Multi-realm translated historical prunes stay explicitly held, retaining both original and translation evidence with bounded safe diagnostics. This is the case where agent-mem#15 AC4 stays unmet; do not silently omit/retag it or claim the cross-realm gap solved.
- Unknown provenance must not be assumed to mean native/untranslated. Existing unmarked v1 transport alone may not reconstruct pre-migration lineage.

Do not design multi-realm transport in this task: no operator need has been reported, and exporting full originals would disclose IDs from unopened realms. Reopen it later as a separate issue only when a concrete need is reported. No new issue is filed now. No Merkle proof, signature trust root or partial-prune acceptance is introduced, and shared-v1/PruneRow hashing is unchanged. D01-D03 are decided; this docs contract must merge before any implementation starts.

## Proposed portable manifest

Names below define the approved target contract, not current exported types. A new versioned shard-transport descriptor would admit this exact, bounded artifact. Existing rows/Entry and PruneRow bodies keep their schemas.

```ts
interface PublicPruneWitnessV1 {
  schema: "agent-mem.public-prune-witness/v1";
  realm: { scope: "project"; key: string } | { scope: "user" };
  prune: PruneRow; // complete original row, never a target subset
  lineage: { kind: "native-generation"; seal: string }
    | { kind: "post-seal"; seal: string; end: number };
  pruneOccurrence: { pack: string; blob: string };
  witnesses: Array<{
    id: string;      // exact Entry ID
    rowHash: string; // full canonical Entry hash, including id
    pack: string;   // existing rows/<author hash>/<pack hash>.jsonl
    blob: string;   // verified Git blob OID for that complete pack
  }>;
}
```

- The closed `lineage` field is a positive publisher statement about the complete `prune.generation`, included in the manifest hash. `native-generation` names the full 64-hex hash of that generation's seal and asserts that its sealed records contain no migration sources. `post-seal` names that seal hash and a nonnegative safe-integer `end`, the sealed migration log end offset; it asserts that the complete prune occurrence was authored after that end. Neither kind changes the original prune ID or attribution.
- The publisher derives these claims from its own sealed generation records. Layer 4 (task 571) owns that derivation and the audited selected-realm evidence path; Layer 1 never reads local seals, migration sources or translation receipts. The receiver validates the closed kind/fields, seal-hash format and offset, and checks the complete prune occurrence against the manifest's original generation and payload. It accepts the statement under D03's owned-source trust premise; the hash alone does not authenticate a seal, prove an offset, or certify person consent. No PKI or subset-membership proof is introduced.
- Missing or unsupported lineage, including historical multi-realm or single-destination migration output (even an unchanged ID) and migrations older than receipts, is `unsupported_lineage`, with a fixed bounded reason and no mask. Absence of receipts never proves native origin. Malformed known lineage claims or invalid/incomplete public proof are `invalid`; validate the complete public proof before classifying otherwise unsupported lineage. A verified result is structural Layer 1 evidence, never active projection or application success.
- Manifest identity is a new full canonical content hash over this artifact; it is not a new prune ID. Receiving generation, selector revision, local install time, current remote tip and credential URL do not enter it.
- Source generation and attribution remain in the full original prune. Target/basis hashes remain in its target list; each distinct referenced Entry appears once in the sorted witness list. Reject duplicates, unused witnesses, unknown fields and conflicting equal-ID bytes.
- The pruneOccurrence resolves the same complete canonical prune in its original author bucket. References point to complete existing public row packs. Decode complete bounded UTF-8/newline-terminated bytes, verify pack hash, Git object identity, author bucket, row schema/ID/hash and physical realm. Never trim blob text or accept a byte-count-only check.
- Resolve public provenance through the existing audited source/publication path. A local private row with matching bytes or a selected-but-unwitnessed export cannot substitute. No boolean public/policy/person marker grants authority.
- Preserve current prune16KiB/32-target and pack1MiB bounds. At most64 distinct target+basis Entry references are needed per prune. Proposed manifest cap is64KiB, containing references rather than copied note bodies; reject oversized records before effects. Implementation must prove this covers permitted metadata/realm keys without silently truncating a valid row.
- A public settle witness remains ineligible where existing placement/transport rules force settle local; the new format does not publicize it. The original PruneRow validator's accepted basis kinds do not override public-source eligibility.
- Preserve delta-only immutable publication and existing rows. Manifests refer to validated existing/new packs in that same selected realm; they never force project-B fetches to complete project-A proof.

A first publisher may use already-valid native/legacy-main public source provenance under the existing policy before atomic publication; a receiver must verify fetched public occurrences. This preserves current publicWitness semantics rather than requiring an artificial extra round trip or upgrading a false witness.

## Validation and refusal order

One explicit sync invocation, under current root/sync/sorted-shard ownership, performs:

- Pin home, aliases, selector/profile version, physical selected realms and remote identity. Positively establish private visibility and strict owned repository/history/config safety using the existing hardened Git boundary. Unknown/public visibility refuses.
- Fetch only the existing exact selected project/user refs with no tags. Audit descriptors, every selected reachable commit and immutable pack path/object; symbolic refs, rewritten ancestry, missing previously known ref or conflicting destination remain refusals.
- Decode all ordinary/native/foreign rows and proposed manifests. Validate the complete original prune at sourceGeneration, exact identity and public placement. Apply D01 eligibility before any new publication/import.
- Resolve all target/basis references from the same realm's verified raw public sources. Reuse the unchanged pure expiry/proof relation rules with sourceGeneration, never receiverGeneration. Do not query a pruned public view to recover raw proof.
- Reject forged, private, local/machine, missing, cross-realm, conflicting or altered witnesses for the whole affected selected preflight. Preserve current all-selected-refs preflight ordering; no partial target subset is an application.
- Run current publication policy over actual values to be published and recheck binding after asynchronous host policy. Withheld/unknown does not justify retagging local, dropping a row or publishing a witness body to make progress.
- Build immutable complete output and local durable-input plans. Publish the selected transport update atomically without follow-tags; recheck selection/current owner before local activation/import.

An invalid/missing proof still refuses before publication or local append. A valid but unsupported cross-generation/lineage case remains an explicit hold under the agreed ceiling, not silent success at application. New status must distinguish transport durable, proof complete, projection active and held/non-applicable; it may not equate held with pruned.

## Durable local input and derived projection

A current hold is not authority. Do not feed it into generation_prunes or flip it to applied. Explicit new-protocol sync must re-fetch/re-prove and install a new typed input from complete proof; the original hold bytes remain immutable historical evidence.

Proposed local layout, in a new supported generation semantics version:

- A content-addressed proof archive retains the manifest and its required public pack/object evidence. Deduplicate by content hash, preserve owned path/descriptor/no-symlink/no-hardlink/private permission checks and fsync; no credential URL or source private body is copied into it.
- A create-once local input descriptor binds manifest hash, remote identity hash, exact source ref/commit/blob, physical realm, receiving generation and selector revision. Receiving metadata is separate from authored attribution. Unknown schemas, partial/pending installation or missing source evidence are never active inputs.
- Source/object anchoring must be validated against the owned accepted transport history, not a public:true or applied:true field. The existing same-user source-storage integrity premise is unchanged; hashes and actor strings do not become authentication. The cumulative input-set commitment below defines accepted membership before any code is added.
- The index records foreign inputs/target mappings in new derived structures. Native generation_prunes stays native and uses the original validator. Effective generation_targets/pruned is the union of native reduction and validated foreign projections under the new reader version.
- All read surfaces, FTS, composed work/relations, brief and search must use that same exact-ID mask; no query-specific sidecar shortcut. No foreign input enters shared-v1 ops/logs, legacy-main, native operation registry or receiver-authored person history.

Proposed local descriptor (not an Entry or a prune), in `public-prune-inputs/<hashJSON(input)>.json` beneath the bound generation directory:

```ts
interface PublicPruneInputV1 {
  schema: "agent-mem.public-prune-input/v1";
  realm: { scope: "project"; key: string } | { scope: "user" };
  receivingGeneration: string;
  selectorRevision: string;
  witnessHash: string;
  source: {
    remoteHash: string;
    ref: string;
    commit: string;
    manifestPath: string;
    manifestBlob: string;
  };
}
```

The source anchor is the exact audited selected-realm Git tree containing the manifest/prune/public packs, with required commit/tree/blob proof objects retained in the owned content archive. It is installed only by the explicit admitted sync path after positive-private/history/policy checks. A reader verifies the input, canonical manifest, complete object/pack content identities, realm ownership and existing expiry rules offline. No private:true/public:true/applied:true bit is accepted as proof. Like current source logs, owned input storage is an integrity premise, not cryptographic authentication of a person's intent; this design does not claim to resist an actor able to replace every trusted local source/anchor or an authorized malicious remote with a wholly new valid history. Existing append-only-history and ownership refusals still apply.

Each descriptor is complete, bounded to 64 KiB and create-once under the existing profile/mutation ownership, with full temporary bytes, atomic publication and directory fsync. Pending/unregistered files are ignored as inputs; conflicting complete bytes refuse. A retry reuses an existing valid descriptor whose anchor remains in the audited source history, rather than rewriting it to a new tip. Equivalent provenance descriptors may add evidence. Collision admission first enforces (physical realm, original prune ID) -> exactly one canonical payload/full hash. Exact (realm, ID, payload hash) repeats then deduplicate masks and authored-prune counts; a different payload under the same realm/ID refuses. Content deduplication uses one validated hash path, not hardlinks into an external cache.

Registration needs an authoritative complete set, not a directory scan. Proposed `agent-mem.public-prune-input-set/v1` is a canonical, immutable, hash-named document containing the receiving generation, predecessor set hash (null only for the activation set), and the sorted unique cumulative descriptor hashes. The v2 selector carries `pruneInputSetHash`, the hash of the root realm map described in D02; each map value names that realm's cumulative Layer 2 set. Activation commits an explicit empty realm map when appropriate. Under the existing shared mutation fence, sync fsyncs proof objects, descriptors and the new cumulative set before atomically replacing and fsyncing the selector commitment. A crash before this last replacement leaves the prior set authoritative; retry may reuse complete unregistered artifacts. No successful admission removes a previously registered descriptor. The descriptor's selector revision records its admission binding; later input-set commits do not invalidate it merely by advancing the current revision. Realm/generation switches still require explicit revalidation.

A fresh rebuild starts from that selector's realm-map commitment, selects only its physical realm's set, verifies the canonical hashes, generation, predecessor chain and every registered descriptor/object, and refuses missing or altered members. Unregistered files cannot supply membership. Deletion of the committed set or one of its members is detectable even after deleting SQLite. Replacing or rolling back the selector and all trusted source commitments together remains outside the stated owned-source integrity premise; a self-hash is not an anti-rollback or authentication mechanism. The selector commitment and registration transaction are part of the approved D02/D03 target, not an existing storage feature.

Rebuild derives the same masks solely from durable validated local input and retained raw public proof, without network/model access. SQLite/cache alone is not source authority. A deleted/altered required source, invalid filename/hash or contradictory input makes the affected reader unavailable; it must not rebuild an empty mask or expose targets. Losing remote connectivity does not invalidate an already durable locally proved mask.

Exact same-ID/canonical replay remains masked. Different IDs remain independent even with equal text. A duplicate public/local occurrence cannot clear a tombstone. A changed payload under the same ID refuses regardless of source order. Proof uses retained raw original rows even when the target or basis is hidden by another prune.

Generation migration/switch may carry only registered eligible neutral inputs after full offline revalidation into the new supported profile; the portable manifest and original prune identity do not change. Stale receiving metadata is not reused across selector/realm changes. Existing T2 translation is not retroactively treated as an unchanged original, per D01.

## Layer 2 storage and replay (task 569)

This internal module is inactive in production. No Store, GenerationIndex, read, capture or FTS path consults it. Layer 3 owns the v2 reader floor and atomic selector commitment; Layer 4 owns admitted sync and publisher lineage derivation. A returned candidate set hash, an archive file or a self-hash is not authorization or active membership. AC4 stays open.

- `preparePublicPruneInput` verifies a complete input and snapshots the generation/realm/selector binding and physical directory identity. A null input prepares an explicit empty activation-set candidate. `persistPublicPruneInput` uses the existing SQLite writer fence, rechecks that binding and returns a candidate commitment only; it never writes a selector/profile.
- `public-prune-objects/<oid>.git` contains complete uncompressed Git object header/body bytes. Offline replay follows the exact admitted source commit through only its path trees to `shard.json` (closed shard-sync/v2 realm descriptor), `prune-witnesses/<witnessHash>.json` and the complete referenced packs. Every OID/path is checked and Layer 1 proof is rerun. Path trees necessarily retain sibling names/OIDs, but sibling subtree/blob bodies are not retained. Extra supplied objects refuse. Layer 4 must admit the source under the existing private-history/policy ceiling before installing it; these structural checks do not authenticate that admission.
- Descriptors retain the approved input schema. `public-prune-input-sets/<hash>.json` is a closed canonical `{schema, receivingGeneration, previous, inputs}` record, with null predecessor only for the initial activation candidate and sorted unique cumulative descriptor hashes. Read/rebuild starts only from the supplied committed hash, verifies the entire predecessor chain and its monotone membership, and never derives membership from directory scans or SQLite. A later selector revision does not invalidate an earlier admitted descriptor.
- Immutable files are private, regular and independent (no symlinks/hardlinks), published from complete exclusive temporary files by create-once link plus file/directory fsync. Exact retries reuse existing bytes. If a crash leaves a final/temp hardlink pair, recovery under the kernel writer fence validates the complete hash-named file and both inode identities, then removes only that matching private temp alias and fsyncs its directory; external hardlinks still refuse. Partial or unregistered artifacts do not grant membership. No stale lock is removed and no committed proof is evicted.
- Per input, retained evidence is at most 80 MiB and 256 Git objects; each object is at most the existing 1 MiB pack allowance plus its header, with commits/JSON metadata bounded to 64 KiB. Replay and archive capacity are bounded to 256 MiB, archive capacity to 16,384 files and predecessor traversal to 4,096 sets. Exceeding a ceiling refuses before archive effects or makes a supplied committed view unavailable; no lifetime membership is truncated. Capacity accounting includes orphaned files but never treats them as members.
- Projection exposes only exact target IDs, full target/basis row-hash bindings and deduplicated original prune counts. Native target masks can be unioned without changing native prune rows. Ordinary entries still come only from their original sources; archive membership never imports them. Matching later ordinary imports stay masked; changed equal-ID bytes refuse. Missing/altered committed sets, descriptors, trees or blobs make replay unavailable even after deleting derived SQLite.

The Layer 2 fixture harness checks offline rebuild/incremental/order/retry parity and filtered public views. Actual production read-path and selector interruption integration remain Layer 3 work.

## Publication, crash and visibility contract

- Preflight all selected realms before any publication/import. Validate old native prune plans and current foreign holds without repairing them eagerly.
- Atomically publish required immutable packs/manifests and descriptor updates. A race or cancelled/rebound attempt publishes/appends nothing unless publication already committed; report that state honestly.
- After publication and binding recheck, fsync all required local inputs before selected ordinary/native imports, retaining today's hold-before-import discipline. Unregistered temporary artifacts cannot be replayed.
- A valid mask may be installed before the ordinary target is imported, because complete proof is in the archive. Subsequent identical-ID import must already be masked. Each realm's derived refresh applies neutral input and ordinary/native rows transactionally.
- Partial input writes never count as active. Create-once publication, exact bytes/ownership, directory fsync and deterministic idempotency keys reuse the original complete descriptor on retry. Never rewrite committed rows or remove a lock on behalf of an inspected dead holder.
- Sync returns application success only after every eligible selected input is durable and projection refresh is valid. Crash after remote publication but before input/import completion is not success; retry re-audits, completes missing inputs and preserves masks before import.
- No cross-realm proof borrowing or false global transaction claim: per-realm masks are exact; whole-sync success waits for all selected realms. Unsupported realms retain explicit holds and AC4 is not claimed for them.

Archive cleanup may not remove proof needed by a live mask. If capacity cannot retain complete required evidence, refuse the new application before publication/activation rather than evict a proof and resurrect data. Current manual history/cache and retained-public-data ceilings remain explicit; this is logical masking, not physical deletion from old Git history or historical homes.

## Decided D02: reader compatibility and activation (2026-10-30)

Old 0.13.0 readers do not know these inputs. Merely adding a sidecar or optional descriptor field is unsafe because rebuild could ignore masks.

Accepted reader floor:

- `agent-mem.profile/v2`, kind generation, retains the existing 32-hex receiving generation and adds closed `foreignPruneFormat: "agent-mem.public-prune-witness/v1"` and `pruneInputSetHash` fields. This single hash names a closed immutable root `agent-mem.public-prune-view/v1` document `{ schema, receivingGeneration, realms }`, with sorted unique keys `user` or `project:<canonical key>` and per-realm Layer 2 input-set hashes. It is hash-named beside the root input sets. `{ realms: {} }` is the explicit empty initial view; an absent realm has no foreign masks. Each realm replays only its own set; no per-shard selector files or cross-realm proof borrowing are introduced. `agent-mem.shards/v2` binds active shard selection to that selector revision. Old readSelector/readShardedSelection reject both exact version changes before active reads; never fall back.
- Do not rewrite the underlying native generation descriptor/seal/logs or retag native/local prune rows. The new selector is a versioned projection view over the same receiving generation and immutable legacy inputs. A new derived `index-v2.db` avoids an unannounced older index writer deleting/overwriting foreign masks in the historical `index.db`; both remain rebuildable, not authority.
- FTS retains the current raw-entry cache invariant: index every retained raw Entry, then resolve results through the active profile's exact-ID mask. Its shared cache is never authority for visibility or foreign-input membership. Preserve the shared mutation fence and current invalidation rules; if implementation changes raw corpus or cache semantics, require a separately versioned FTS namespace before acceptance. No query may return raw FTS text before masking.
- `agent-mem.shard-sync/v2` descriptors admit exact `prune-witnesses/<hash>.json` paths plus unchanged public row packs. Ref names stay the same exact selected project/user refs. New readers validate v1 historical commits and an explicit v1-to-v2 transition; old readers refuse the new tip/paths before publication/import, rather than ignore them. No dual-publish success that pretends old readers apply tombstones.
- Explicit person-run selection/view migration occurs only after supported hosts are installed/quiesced through current cooperating-reader admission. No read/capture call upgrades a marker. Build the v2 index from all current native/local masks plus supported neutral inputs before publishing the new selector; refuse activation if any previously effective native/local mask would be lost. Source bytes stay unchanged.
- Existing unsplit/shared-v1 paths and Entry/PruneRow hashes are unchanged. The v2 projection is inactive outside the explicit supported profile. Published unannounced older readers can keep reading unchanged historical bytes, the existing C1 ceiling; a process scan proves no absence and old data was not erased. Such a historical view must not be reported as the current v2 view to an agent.

Layer 3 exposes `amem migrate --public-prune-view [--dry-run|--apply|--resume] [--json]` on an active split. The receiving generation comes from that split, including splits born from an absent/shared-v1 root profile. Dry-run is a read-only metadata/complete-proof preview; mask building is explicitly deferred to apply. Apply preserves every effective native/local mask, builds `index-v2.db`, fsyncs all immutable inputs and the root realm map under the profile/reader and sorted mutation fences, and then publishes a create-once intent containing the exact final profile/shards bytes and hashes. It atomically replaces shards.json v2 first, then profile.json v2 as the sole commit point, removes the intent and fsyncs the directory. Existing shard journal fields are preserved; unsupported extra fields refuse before mutation.

Any intent or inconsistent profile/shards pair makes ordinary readers unavailable, never a historical fallback. Resume validates the exact intent and completes forward only; no intent plus a consistent view is a verified no-op. Returning to v1 would resurrect masked entries, so deactivate/rollback is unavailable. A later map cannot remove an existing realm, and each changed realm set must descend from its previous committed set. A matching mask alone does not authorize a new unrelated chain.

Compatible shard handles announce separate `shard-readers/` cooperating leases, including opens before lazy initialization. V2 activation quiesces both legacy and shard leases. Existing v1 shard resume retains its captured-phase/mutation fencing of live shard handles, rather than treating them as legacy pre-split readers. Current handles verify intent/selector/realm binding and the complete proof on opening/rebuild; subsequent reads recheck the verified source file and parent ownership/identity frontier, replaying changed evidence and refusing missing members. This cache is in-process only, never SQLite or durable membership authority. FTS remains raw retained Entry text; get/list/search/intent/history/relations and catalog counts pass through the active exact-ID mask. A root generation's old index is not overwritten by the v2 projection.

Actual supported published older readers return their unsupported/unavailable result against either new marker and never silently reopen the legacy view. Unannounced readers that ignore markers can still inspect unchanged historical bytes; no erasure or process-scan absence proof is claimed.

The transport/v2 activation remains Layer 4 work. The profile/shard/transport schema names and closed fields above are the accepted target floor, not already-published versions. The old/new host matrix, explicit transition/rollback behavior and user-visible unsupported result are implementation acceptance requirements. A software version guess or permissive unknown-field parsing is not a floor.

## Decided D03: durable proof anchoring and resource accounting (2026-10-30)

The proposed input descriptor/content archive above specifies offline replay and create-once registration. The planner accepts the complete anchor/object graph, scope and current same-user source-storage integrity premise as stated; a metadata-only receipt or self-hash cannot certify publicness or consent. No new key registry or signature trust model is silently introduced. If stronger authorship authentication is required, that is an additional explicit design prerequisite.

References keep the manifest small, but a prune can require 64 public rows from up to 65 existing 1 MiB packs including its prune pack. Deduplicated content storage, streaming verification and existing source-index frontiers are required; no small-RSS/read-latency claim follows from a 64 KiB manifest. Preserve full selected history audit, no lifetime cutoff/row omission. Resource excess is an explicit refusal/pending result, not incomplete proof labelled complete. Meet existing #13 opening/read/capture budgets before implementation is accepted; capture/read never fetch, call models, start a resident helper or access other projects to repair proof.

## Required test matrix before implementation acceptance

| Case | Required result |
| --- | --- |
| G1 and G2 independently initialized, project A, public expired note and basis | G2 applies exact original G1 prune through neutral input; original IDs/generation/author/hash unchanged; no native foreign append |
| Reverse G2 to G1 and a third generation | Same deterministic result; receiving identity is metadata only |
| Public immutable legacy-main targets/bases migrated without target reslicing | Original Entry bytes/IDs and public provenance preserved; foreign masking and search/SessionStart brief agree |
| Legacy synced placement but false witness, already locally pruned before first publication | No first publication of deleted text to invent proof; current privacy regression remains green |
| Valid same-generation prune | Existing native append-plan/rebuild path unchanged |
| Private/local/machine/short/settle witness or forged public flag | Refuse before effects; no metadata flag upgrades provenance |
| Missing, forged hash, wrong expiry/kind/target, malformed UTF-8 or partial pack | Whole affected preflight refuses; no selected publish/append |
| Same ID, different canonical bytes, in either order | Refuse; no preference for public/private/source order |
| Duplicate exact payload/input and later identical ordinary import | Idempotent masks/counts; no resurrection or duplicate authored prune |
| Different ID with equal text | No implicit masking by text or lineage guess |
| Project B or user overlay offered to prove project A | Refuse; no B fetch and no cross-realm proof borrowing |
| Alias/selector/realm changes during asynchronous policy or publication boundary | No stale activation/import; exact existing guard behavior |
| Historical cross-realm/T2 translated original not fully provable | Explicit non-application hold, original/translation evidence unchanged, no partial acceptance or AC4 claim |
| Existing old hold copied into new input path | Not application authority; explicit re-proof/typed installation required |
| Missing/altered durable input after prior masking | Reader unavailable, never a successful empty-mask rebuild |
| Publication, input-temp, input-fsync, input-set-fsync, selector-commit, activation, ordinary/native import interruptions | Exact retry; no unmasked first-import window or rewritten complete line |
| Remote public/unknown, GH_HOST mismatch, multiple push URLs, symbolic refs, unowned repo or rewritten ancestry | Existing positive-private/owned-history refusal unchanged |
| Replacement remote missing selected history | Existing refusal/remedy; do not delete cache/proof or replace with empty history |
| Old reader against new selector/descriptor, new reader against old paths | Old refuses new semantics, new preserves old semantics; no silent mask omission |
| Incremental versus full rebuild across all valid order/duplicate/retry cases | Identical effective mask and public views; no network/model required for rebuild/read |
| Capture/read/brief spies and resource fixtures | Zero fetch/model/resident-helper; exact lazy refs only during explicit sync; no unsupported budget claim |

Use isolated homes, an explicitly private local/test remote, fixed synthetic data, current hardened Git and owned process cleanup. No test reads the person's live memory home. Reuse the existing same-generation, ordinary cross-generation, private-remote, legacy-first-publication, holds, collision and migration regressions; add the new projection cases without weakening them.

## Review and implementation gate

- Confirm the current 0.13.0 held-transport baseline rather than the obsolete all-sync refusal.
- Preserve the decided D01 single-realm ceiling and visible historical cross-realm AC4 gap, accepted D02 reader floor and D03 source-storage/resource ceiling. These are target contracts; no runtime API or version is implemented by this document.
- After this docs contract merges, propose priority 3 implementation backlog cards, one per layer: manifest+validation, durable inputs+input set, v2 profile/selector activation, and sync transport v2. Each card carries its relevant rows of the matrix above. Start no implementation before then. Every card preserves original bytes/IDs, physical realm/public proof, current private-remote/history/Git boundaries and fail-closed reads.
- AC4 is not closed by this proposal, a hold, transport success, a new marker or a partial target projection. It needs the accepted two-generation public-prune application and migration/provenance proof, with any remaining ceiling explicitly reported.
