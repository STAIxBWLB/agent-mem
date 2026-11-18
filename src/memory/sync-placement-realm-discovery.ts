/** Bounded, data-only parsing of the selected placement remote's advertised project refs. */
import type { SyncPlacementRealmBinding } from "./sync-placement-plan.ts";
import type { EffectiveRealmInventory } from "./sync-placement-realm-effective.ts";

const REF_BYTES = 256 * 1024, REF_COUNT = 4096;
export interface RemoteOnlyRealm { scope: "project"; keyHash: string }
const unavailable = (): never => { throw new Error("Remote placement realm listing is unavailable or exceeds its bound; inspect the remote before continuing."); };

/** Names are never inferred from ref hashes; invalid or ambiguous input refuses the entire listing. */
export function remoteOnlyPlacementRealms(bytes: Uint8Array, inventory: readonly SyncPlacementRealmBinding[]): RemoteOnlyRealm[] {
  if (bytes.byteLength > REF_BYTES || inventory.length > REF_COUNT) return unavailable();
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return unavailable(); }
  if (text && !text.endsWith("\n")) return unavailable();
  const local = new Set<string>();
  for (const realm of inventory) {
    if (realm.scope === "user") continue;
    if (realm.scope !== "project" || !/^[a-f0-9]{64}$/.test(realm.keyHash)) return unavailable();
    const hash = realm.keyHash.slice(0, 16);
    if (local.has(hash)) return unavailable();
    local.add(hash);
  }
  const remote = new Set<string>(), lines = text ? text.slice(0, -1).split("\n") : [];
  if (lines.length > REF_COUNT) return unavailable();
  for (const line of lines) {
    const match = /^([a-f0-9]{40})\trefs\/heads\/amem\/p\/([a-f0-9]{16})$/.exec(line);
    if (!match || remote.has(match[2]!)) return unavailable();
    remote.add(match[2]!);
  }
  return [...remote].filter(hash => !local.has(hash)).sort().map(keyHash => ({ scope: "project", keyHash }));
}

/** The transport owns the bounded remote call; inventory must remain current across the await. */
export async function listRemotePlacementRealms(inventory: EffectiveRealmInventory, advertise: () => Promise<Uint8Array>): Promise<RemoteOnlyRealm[]> {
  inventory.assertCurrent();
  const bytes = await advertise();
  inventory.assertCurrent();
  const realms = remoteOnlyPlacementRealms(bytes, inventory.realms);
  inventory.assertCurrent();
  return realms;
}
