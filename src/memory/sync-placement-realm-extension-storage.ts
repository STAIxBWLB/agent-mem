/** Read the separate same-epoch extension chain without changing activation or acquiring a writer lease. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import { canonicalJSON } from "./generation.ts";
import { homeIdentityMatches } from "./home-identity.ts";
import { realPath } from "./platform.ts";
import { REALM_EXTENSION_LIMIT, REALM_EXTENSION_LOG_MAX_BYTES, RealmExtensionFormatError, realmExtensionGenesis,
  validateRealmExtension, type RealmExtension } from "./sync-placement-realm-extension-format.ts";

export const REALM_EXTENSION_LOG = "placement-realm-extensions.jsonl";
export interface RealmExtensionBinding { epochHash: string; activationHash: string; homeHash: string; generation: string; initialProjectHashes: readonly string[] }
export interface RealmExtensionHistory { records: readonly RealmExtension[]; headHash: string; assertCurrent(): void }
const fail = (): never => { throw new RealmExtensionFormatError(); };
const stamp = (stat: BigIntStats) => [stat.dev, stat.ino, stat.uid, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(":");
function owned(stat: BigIntStats, directory: boolean): void {
  if (stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid?.() ?? -1)
    || (directory ? !stat.isDirectory() || (stat.mode & 0o077n) !== 0n : !stat.isFile() || stat.nlink !== 1n || (stat.mode & 0o777n) !== 0o600n)) fail();
}
/** A torn, modified or mismatched chain is unavailable; no subset is silently accepted. */
export function readRealmExtensionHistory(homeInput: string, binding: RealmExtensionBinding): RealmExtensionHistory {
  try { return readHistory(homeInput, binding); } catch { return fail(); }
}
function readHistory(homeInput: string, binding: RealmExtensionBinding): RealmExtensionHistory {
  const home = realPath(homeInput), original = lstatSync(homeInput, { bigint: true }), root = lstatSync(home, { bigint: true });
  owned(original, true); owned(root, true);
  if (original.dev !== root.dev || original.ino !== root.ino || !homeIdentityMatches(binding.homeHash, home, root)) return fail();
  const file = join(home, REALM_EXTENSION_LOG), before = lstatSync(file, { bigint: true, throwIfNoEntry: false });
  const checks = () => { try {
    const nowHome = lstatSync(home, { bigint: true }), nowOriginal = lstatSync(homeInput, { bigint: true });
    owned(nowHome, true); owned(nowOriginal, true);
    if (nowHome.dev !== root.dev || nowHome.ino !== root.ino || nowOriginal.dev !== original.dev || nowOriginal.ino !== original.ino) fail();
    const now = lstatSync(file, { bigint: true, throwIfNoEntry: false });
    if (!before) { if (now) fail(); return; }
    if (!now) return fail(); owned(now, false); if (stamp(now) !== stamp(before)) fail();
  } catch { fail(); } };
  const genesis = realmExtensionGenesis(binding.epochHash, binding.activationHash);
  if (!before) return { records: [], headHash: genesis, assertCurrent: checks };
  owned(before, false); if (before.size <= 0n || before.size > BigInt(REALM_EXTENSION_LOG_MAX_BYTES)) return fail();
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    const opened = fstatSync(fd, { bigint: true }); owned(opened, false); if (stamp(opened) !== stamp(before)) return fail();
    const data = Buffer.alloc(Number(opened.size) + 1); let at = 0;
    while (at < data.length) { const n = readSync(fd, data, at, data.length - at, at); if (!n) break; at += n; }
    if (at !== Number(opened.size) || stamp(fstatSync(fd, { bigint: true })) !== stamp(opened)) return fail();
    bytes = data.subarray(0, at);
  } finally { closeSync(fd); }
  checks();
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); if (!text.endsWith("\n")) return fail();
  const lines = text.slice(0, -1).split("\n"); if (!lines.length || lines.length > REALM_EXTENSION_LIMIT) return fail();
  const records: RealmExtension[] = [], seen = new Set(binding.initialProjectHashes), prefixes = new Set(binding.initialProjectHashes.map(hash => hash.slice(0, 16)));
  if (prefixes.size !== binding.initialProjectHashes.length) return fail();
  let head = genesis, journalSequence = 0, journalHead = binding.epochHash;
  for (const [index, line] of lines.entries()) {
    const record = validateRealmExtension(JSON.parse(line));
    if (canonicalJSON(record) !== line || record.sequence !== index + 1 || record.previousHash !== head
      || record.epochHash !== binding.epochHash || record.activationHash !== binding.activationHash || record.homeHash !== binding.homeHash
      || record.generation !== binding.generation || seen.has(record.realm.keyHash) || prefixes.has(record.realm.keyHash.slice(0, 16))
      || record.journal.sequence < journalSequence || record.journal.sequence === journalSequence && record.journal.headHash !== journalHead) return fail();
    seen.add(record.realm.keyHash); prefixes.add(record.realm.keyHash.slice(0, 16)); head = record.seal;
    journalSequence = record.journal.sequence; journalHead = record.journal.headHash;
    Object.freeze(record.realm); Object.freeze(record.journal); records.push(Object.freeze(record));
  }
  checks(); return { records: Object.freeze(records), headHash: head, assertCurrent: checks };
}
