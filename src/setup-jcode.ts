import { isDeepStrictEqual } from "node:util";
import type { ConfigImage } from "./setup-owned.ts";
import { SETUP_CONFIG_BYTES } from "./setup-toml.ts";

interface Member { key: string; keyStart: number; keyEnd: number; valueStart: number; valueEnd: number; comma?: number }
interface ObjectSpan { close: number; members: Member[] }
interface Document { text: string; root: ObjectSpan; container?: Member; servers?: ObjectSpan; owned?: Member }
interface Edit { start: number; end: number; text: string }
const decode = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const same = (a: ConfigImage, b: ConfigImage) => a.bytes === b.bytes && a.mode === b.mode;
const fail = (): never => { throw Error("setup Jcode MCP configuration unavailable or ambiguous; no configuration changed"); };
const whitespace = (text: string, start: number) => { let at = start; while (at < text.length && /[ \t\r\n]/.test(text[at]!)) at++; return at; };
function stringEnd(text: string, start: number): number {
  let at = start + 1;
  while (at < text.length) { if (text[at] === "\\") at += 2; else if (text[at++] === '"') return at; }
  return fail();
}
/** JSON.parse validates syntax first; this scanner retains only lexical edit boundaries. */
function valueEnd(text: string, start: number): number {
  if (text[start] === '"') return stringEnd(text, start);
  if (text[start] === "{" || text[start] === "[") {
    let depth = 0, at = start;
    while (at < text.length) {
      const char = text[at]!;
      if (char === '"') { at = stringEnd(text, at); continue; }
      if (char === "{" || char === "[") depth++;
      else if ((char === "}" || char === "]") && --depth === 0) return at + 1;
      at++;
    }
    return fail();
  }
  let at = start; while (at < text.length && !/[ \t\r\n,}\]]/.test(text[at]!)) at++; return at;
}
function objectSpan(text: string, start: number): ObjectSpan {
  if (text[start] !== "{") return fail();
  const members: Member[] = []; let at = whitespace(text, start + 1);
  while (text[at] !== "}") {
    const keyStart = at, keyEnd = stringEnd(text, at), key: unknown = JSON.parse(text.slice(keyStart, keyEnd));
    if (typeof key !== "string") return fail();
    const valueStart = whitespace(text, whitespace(text, keyEnd) + 1), end = valueEnd(text, valueStart), next = whitespace(text, end);
    const comma = text[next] === "," ? next : undefined;
    members.push({ key, keyStart, keyEnd, valueStart, valueEnd: end, ...(comma === undefined ? {} : { comma }) });
    at = comma === undefined ? next : whitespace(text, comma + 1);
  }
  return { close: at, members };
}
/** Only the owned value requires recursive key uniqueness; unrelated JSON stays opaque. */
function uniqueOwnedKeys(text: string, member: Member): void {
  const objects: (Set<string> | null)[] = [];
  let at = member.valueStart;
  while (at < member.valueEnd) {
    const char = text[at]!;
    if (char === '"') {
      const end = stringEnd(text, at), current = objects.at(-1);
      if (text[whitespace(text, end)] === ":" && current) {
        const key = JSON.parse(text.slice(at, end)) as string;
        if (current.has(key)) return fail();
        current.add(key);
      }
      at = end;
    } else {
      if (char === "{") objects.push(new Set());
      else if (char === "[") objects.push(null);
      else if (char === "}" || char === "]") objects.pop();
      at++;
    }
  }
}
function document(image: ConfigImage): Document {
  let text = "{}";
  if (image.bytes !== null) {
    if (image.bytes.length > Math.ceil(SETUP_CONFIG_BYTES / 3) * 4) return fail();
    const bytes = Buffer.from(image.bytes, "base64");
    if (bytes.toString("base64") !== image.bytes || bytes.length > SETUP_CONFIG_BYTES) return fail();
    try { text = decode.decode(bytes); } catch { return fail(); }
  }
  let value: unknown; try { value = JSON.parse(text); } catch { return fail(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const root = objectSpan(text, whitespace(text, 0));
  const containers = root.members.filter(member => member.key === "servers" || member.key === "mcpServers");
  if (containers.length > 1) return fail();
  const container = containers[0]; if (!container) return { text, root };
  const servers = objectSpan(text, container.valueStart), owned = servers.members.filter(member => member.key === "amem");
  if (owned.length > 1) return fail();
  if (owned[0]) uniqueOwnedKeys(text, owned[0]);
  return { text, root, container, servers, ...(owned[0] ? { owned: owned[0] } : {}) };
}
const entry = (doc: Document): unknown => doc.owned ? JSON.parse(doc.text.slice(doc.owned.valueStart, doc.owned.valueEnd)) : undefined;
export function readJcodeMcp(image: ConfigImage): unknown { return entry(document(image)); }

function insert(object: ObjectSpan, text: string): Edit {
  const last = object.members.at(-1);
  const at = last?.valueEnd ?? object.close;
  return { start: at, end: at, text: `${last ? "," : ""}${text}` };
}
function remove(object: ObjectSpan, member: Member): Edit {
  if (member.comma !== undefined) return { start: member.keyStart, end: member.comma + 1, text: "" };
  const previous = object.members[object.members.indexOf(member) - 1];
  return { start: previous?.comma ?? member.keyStart, end: member.valueEnd, text: "" };
}
function publish(image: ConfigImage, doc: Document, edits: Edit[]): ConfigImage {
  let text = doc.text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  if (text === doc.text) return image;
  if (Buffer.byteLength(text) > SETUP_CONFIG_BYTES) return fail();
  const result = { bytes: Buffer.from(text).toString("base64"), mode: image.mode };
  document(result); return result;
}
function put(image: ConfigImage, value: unknown, options: { key?: string; keepEmpty?: boolean; rawValue?: string; emptyContainer?: string } = {}): ConfigImage {
  const doc = document(image), edits: Edit[] = [], key = options.key ?? "servers";
  if (!doc.container) {
    if (value === undefined && !options.keepEmpty) return image;
    const body = value === undefined ? options.emptyContainer ?? "{}" : `{"amem":${options.rawValue ?? JSON.stringify(value)}}`;
    edits.push(insert(doc.root, `${JSON.stringify(key)}:${body}`));
  } else if (value === undefined && !options.keepEmpty && doc.servers!.members.every(member => member.key === "amem")) {
    edits.push(remove(doc.root, doc.container));
  } else {
    if (doc.container.key !== key) edits.push({ start: doc.container.keyStart, end: doc.container.keyEnd, text: JSON.stringify(key) });
    if (value === undefined && doc.owned) edits.push(remove(doc.servers!, doc.owned));
    else if (value !== undefined && !isDeepStrictEqual(entry(doc), value)) {
      const rendered = options.rawValue ?? JSON.stringify(value); if (rendered === undefined) return fail();
      edits.push(doc.owned ? { start: doc.owned.valueStart, end: doc.owned.valueEnd, text: rendered } : insert(doc.servers!, `"amem":${rendered}`));
    }
  }
  return publish(image, doc, edits);
}
/** Canonicalize only the owned container key; all unrelated bytes remain untouched. */
export function putJcodeMcp(image: ConfigImage, value: unknown): ConfigImage { return put(image, value); }

/** Restore the owned entry (and our alias rename), preserving unrelated lexical edits. */
export function restoreJcodeMcp(before: ConfigImage, after: ConfigImage, current: ConfigImage): ConfigImage {
  const original = document(before), installed = document(after), live = document(current);
  if (same(current, after)) return before;
  if (same(current, before)) return current;
  const previous = entry(original), expected = entry(installed), present = entry(live);
  const previousRestored = isDeepStrictEqual(present, previous);
  const pendingLayout = !!original.container && !!installed.container && original.container.key !== installed.container.key && live.container?.key === installed.container.key;
  if (previousRestored && !pendingLayout) return current;
  if (!previousRestored && !isDeepStrictEqual(present, expected)) throw Error("setup-owned Jcode MCP entry changed; refusing to overwrite it");
  const restored = put(current, previous, { key: original.container?.key ?? "servers", keepEmpty: !!original.container && !original.servers!.members.length,
    ...(original.owned ? { rawValue: original.text.slice(original.owned.valueStart, original.owned.valueEnd) } : {}),
    ...(original.container && !original.servers!.members.length ? { emptyContainer: original.text.slice(original.container.valueStart, original.container.valueEnd) } : {}) });
  return before.bytes === null && !document(restored).root.members.length ? { bytes: null, mode: current.mode } : restored;
}
