/** Private publication durability only. Callers verify policy, object bytes, remote CAS and row acknowledgements. */
import { canonicalJSON } from "./generation.ts";
import { SyncPlacementJournalError } from "./sync-placement-journal-format.ts";
import { withPlacementPublicationMetadata, readPlacementPublicationMetadata, type PlacementStorageOptions, type PlacementPublicationStored } from "./sync-placement-journal-storage.ts";
import { validatePlacementPublicationBundle, createPlacementPublicationFact, publicationFileNames, publicationBytes,
  type PlacementPublicationBundle, type PlacementPublicationPhase, type PlacementPublicationFact } from "./sync-placement-publication-plan.ts";

function fail(code: "invalid" | "pending" | "conflict" | "changed" = "invalid"): never { throw new SyncPlacementJournalError(code); }
const stem = (attempt: string) => `publication-${attempt}-`;
const validHash = (value: string) => typeof value === "string" && value.length === 64 && /^[a-f0-9]+$/.test(value);
/** No timestamp expiry or eviction: retained plans remain charged to the epoch's shared 256-object inventory. */
export function preparePlacementPublication(home: string, input: PlacementPublicationBundle, opts: PlacementStorageOptions): { attemptHash: string } {
  const bundle = validatePlacementPublicationBundle(input), root = bundle.root, names = publicationFileNames(root);
  const required = readPlacementPublicationMetadata(home, root.epochHash, io => [...names, ...io.reservedJournalNames(root)]);
  return withPlacementPublicationMetadata(home, root.epochHash, opts, required, io => {
    const journal = io.journal();
    if (journal.pending || journal.epoch.generation !== root.generation || journal.epoch.homeHash !== root.homeHash
      || journal.sequence !== root.journal.sequence || journal.headHash !== root.journal.headHash) fail("changed");
    const own = stem(root.seal);
    for (const name of io.names()) if (name.startsWith("publication-") && !name.startsWith(own)) {
      const match = /^publication-([a-f0-9]{64})-/.exec(name); if (!match) fail("pending");
      const other = io.publication(match[1]!); if (other.phase !== "completed" || other.pending) fail("pending");
    }
    for (const name of io.names()) if (name.startsWith(own) && !names.includes(name)) fail("conflict");
    // Reserve every future phase file physically. A later journal append cannot consume these object slots.
    for (const suffix of ["artifact", "intent", "receipt"]) {
      const name = `${own}${suffix}.json`;
      if (io.read(name) === undefined) io.complete(name, Buffer.alloc(0), "publication-slot-written", "publication-slot-fsync");
    }
    for (const chunk of bundle.chunks) io.complete(`${own}chunk-${String(chunk.index).padStart(5, "0")}.json`, publicationBytes(chunk), "publication-chunk-written", "publication-chunk-fsync");
    // The root is the final durability acknowledgement: all chunks and all reserved slots precede its fsync.
    io.complete(`${own}root.json`, publicationBytes(root), "publication-root-written", "publication-root-fsync");
    io.check(); const done = io.publication(root.seal);
    if (done.pending || canonicalJSON(done.bundle) !== canonicalJSON(bundle)) fail("changed");
    return { attemptHash: root.seal };
  });
}
export interface PlacementPublicationRead extends PlacementPublicationStored {
  reservedRecords: number; consumedRecords: number;
}
export function readPlacementPublication(home: string, epochHash: string, attemptHash: string): PlacementPublicationRead {
  if (!validHash(attemptHash)) fail();
  return readPlacementPublicationMetadata(home, epochHash, io => {
    const read = io.publication(attemptHash), journal = io.journal(), root = read.bundle.root;
    if (journal.epoch.generation !== root.generation || journal.epoch.homeHash !== root.homeHash) fail("changed");
    const consumedRecords = journal.sequence - root.journal.sequence;
    if (consumedRecords < 0 || consumedRecords > root.reservedRecords && read.phase !== "completed") fail("conflict");
    return { ...read, reservedRecords: root.reservedRecords, consumedRecords };
  });
}
export type PlacementPublicationFactInput = { exportHash: string }
  | { artifactFactHash: string; policyHash: string; policyCheckUnixMs: number }
  | { intentFactHash: string | null; journal: { sequence: number; headHash: string }; outcomeHash: string; outcome: "committed" | "unknown" };
export function recordPlacementPublicationPhase(home: string, epochHash: string, attemptHash: string, phase: PlacementPublicationPhase,
  input: PlacementPublicationFactInput, opts: PlacementStorageOptions): void {
  if (!validHash(attemptHash)) fail();
  const read = readPlacementPublication(home, epochHash, attemptHash), names = publicationFileNames(read.bundle.root);
  const index = ["artifact-built", "publication-intent", "completed"].indexOf(phase); if (index < 0) fail();
  const existing = read.facts.find(fact => fact.phase === phase);
  const prior = phase === "completed" ? read.facts.filter(fact => fact.phase !== "completed").at(-1)
    : phase === "publication-intent" ? read.facts.find(fact => fact.phase === "artifact-built") : undefined;
  const previous = existing?.previousHash ?? prior?.seal ?? (phase === "publication-intent" ? undefined : read.bundle.root.seal);
  if (!previous) fail("pending");
  const fact = createPlacementPublicationFact(attemptHash, previous, phase, input);
  const file = `${stem(attemptHash)}${["artifact", "intent", "receipt"][index]}.json`;
  withPlacementPublicationMetadata(home, epochHash, opts, names, io => {
    const before = io.publication(attemptHash), journal = io.journal();
    const saved = before.facts.find(value => value.phase === phase);
    if (before.pending && before.pendingPhase !== phase) fail("pending");
    if (before.phase === "completed") {
      if (!saved || canonicalJSON(saved) !== canonicalJSON(fact)) fail("conflict");
      io.complete(file, publicationBytes(fact), "publication-fact-written", "publication-fact-fsync"); io.check(); return;
    }
    const durablePrior = phase === "completed" ? before.facts.at(-1)
      : phase === "publication-intent" ? before.facts.find(value => value.phase === "artifact-built") : undefined;
    if ((saved?.previousHash ?? durablePrior?.seal ?? read.bundle.root.seal) !== previous) fail("changed");
    if (phase === "artifact-built" && before.phase !== "prepared" && !saved || phase === "publication-intent" && !durablePrior) fail("pending");
    if (fact.phase === "publication-intent" && (fact.artifactFactHash !== previous || fact.policyHash !== read.bundle.root.policyHash || fact.policyCheckUnixMs !== read.bundle.root.policySnapshotUnixMs)) fail("conflict");
    if (fact.phase === "completed") {
      const intent = before.facts.find(value => value.phase === "publication-intent");
      if (journal.pending || fact.intentFactHash !== (intent?.seal ?? null) || fact.journal.sequence !== journal.sequence || fact.journal.headHash !== journal.headHash
        || fact.outcome === "committed" && (!intent || journal.sequence !== read.bundle.root.journal.sequence + read.bundle.root.reservedRecords)) fail("conflict");
    }
    io.complete(file, publicationBytes(fact), "publication-fact-written", "publication-fact-fsync");
    io.check(); const done = io.publication(attemptHash); if (canonicalJSON(done.facts.find(value => value.phase === phase)) !== canonicalJSON(fact)) fail("changed");
  });
}
