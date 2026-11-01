import { isDeepStrictEqual } from "node:util";
import { SETUP_CONFIG_BYTES, setTomlPath, updateTomlArray } from "./setup-toml.ts";
import { readJcodeMcp, putJcodeMcp, restoreJcodeMcp, jcodeHooksManaged, restoreJcodeHooks } from "./setup-jcode.ts";
import { readAgyMcp, putAgyMcp, restoreAgyMcp } from "./setup-agy.ts";
import { readOpencodeMcp, putOpencodeMcp, restoreOpencodeMcp } from "./setup-opencode.ts";
export interface ConfigImage { bytes: string | null; mode: number }
export const sameImage = (a: ConfigImage, b: ConfigImage): boolean => a.bytes === b.bytes && a.mode === b.mode;
const text = (image: ConfigImage) => image.bytes === null ? "" : new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(image.bytes, "base64"));
const object = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("setup configuration must be an object"); return value as Record<string, unknown>; };
const json = (image: ConfigImage) => image.bytes === null ? {} : object(JSON.parse(text(image)));
const toml = (image: ConfigImage) => image.bytes === null ? {} : object(Bun.TOML.parse(text(image)));
const rendered = (value: string, current: ConfigImage): ConfigImage => ({ bytes: Buffer.from(value).toString("base64"), mode: current.mode });
function finishJson(value: Record<string, unknown>, current: ConfigImage, original: ConfigImage): ConfigImage {
  if (isDeepStrictEqual(value, json(current))) return current;
  if (original.bytes === null && Object.keys(value).length === 0) return { ...original, mode: current.mode };
  const pretty = JSON.stringify(value, null, 2) + "\n", output = Buffer.byteLength(pretty) <= SETUP_CONFIG_BYTES ? pretty : JSON.stringify(value) + "\n";
  if (Buffer.byteLength(output) > SETUP_CONFIG_BYTES) throw Error("semantic setup restore exceeds the size bound");
  return rendered(output, current);
}
export function mcpRecord(target: string, image: ConfigImage): unknown {
  if (target === "agy") return readAgyMcp(image);
  if (target === "opencode") return readOpencodeMcp(image);
  if (target === "jcode") return readJcodeMcp(image);
  const doc = target === "codex" ? toml(image) : json(image), servers = doc[target === "codex" ? "mcp_servers" : "mcpServers"];
  return servers === undefined ? undefined : object(servers).amem;
}
export function putMcpRecord(target: string, current: ConfigImage, value: unknown): ConfigImage {
  if (target === "agy") return putAgyMcp(current, value);
  if (target === "opencode") return putOpencodeMcp(current, value);
  if (target === "jcode") return putJcodeMcp(current, value);
  if (target === "codex") return rendered(setTomlPath(text(current), ["mcp_servers", "amem"], value), current);
  const doc = json(current), servers = { ...object(doc.mcpServers ?? {}) };
  if (value === undefined) delete servers.amem; else servers.amem = value;
  if (Object.keys(servers).length) doc.mcpServers = servers; else delete doc.mcpServers;
  return finishJson(doc, current, { bytes: null, mode: current.mode });
}
interface Hook { event: string; matcher: string; core: Record<string, unknown>; id: string; command: string }
// QwenLM/qwen-code 1ce1731 packages/core/src/hooks/types.ts HOOKS_CONFIG_FIELDS.
// These are user-owned controls, not event groups; setup never enables or restores them.
const qwenHookControls = new Set(["enabled", "disabled", "notifications"]);
const matcher = (value: unknown) => value === undefined || value === "" || value === "*" ? "*" : String(value);
function hook(event: string, group: Record<string, unknown>, value: unknown, strict = false): Hook | undefined {
  const h = object(value);
  const core = h.type === "command" && !strict ? { type: h.type, command: h.command, ...(h.timeout !== undefined ? { timeout: h.timeout } : {}) }
    : Object.fromEntries(Object.entries(h).filter(([key]) => !["trusted_hash", "trustedHash"].includes(key)).sort(([a], [b]) => a.localeCompare(b)));
  const match = matcher(group.matcher);
  const groupCore = strict ? Object.fromEntries(Object.entries(group).filter(([key]) => !["matcher", "hooks"].includes(key)).sort(([a], [b]) => a.localeCompare(b))) : undefined;
  return { event, matcher: match, core, command: typeof h.command === "string" ? h.command : "", id: JSON.stringify([event, match, core, ...(strict ? [groupCore] : [])]) };
}
function hooks(doc: Record<string, unknown>, strict = false): Hook[] {
  const out: Hook[] = [];
  for (const [event, raw] of Object.entries(object(doc.hooks ?? {}))) {
    if (strict && qwenHookControls.has(event)) continue;
    if (!Array.isArray(raw)) throw Error("setup hook groups must be arrays");
    for (const value of raw) { const group = object(value); if (!Array.isArray(group.hooks)) throw Error("setup hook handlers must be arrays"); for (const h of group.hooks) { const row = hook(event, group, h, strict); if (row) out.push(row); } }
  }
  return out;
}
function added<T>(before: T[], after: T[], key: (value: T) => string): T[] {
  const counts = new Map<string, number>(); for (const row of before) counts.set(key(row), (counts.get(key(row)) ?? 0) + 1);
  return after.filter(row => { const id = key(row), n = counts.get(id) ?? 0; if (!n) return true; counts.set(id, n - 1); return false; });
}
function restoreJsonHooks(before: ConfigImage, after: ConfigImage, current: ConfigImage, strict = false): ConfigImage {
  const b = json(before), a = json(after), c = json(current), original = hooks(b, strict), installed = hooks(a, strict), live = hooks(c, strict);
  const ours = added(original, installed, row => row.id), remaining = new Map<string, number>();
  for (const row of ours) {
    const count = live.filter(value => value.id === row.id).length;
    if (!count && live.some(value => value.command === row.command && !original.some(old => old.id === value.id))) throw Error("setup-owned hook changed; refusing to overwrite it");
    if (count) remaining.set(row.id, (remaining.get(row.id) ?? 0) + 1);
  }
  const groups = object(c.hooks ?? {});
  for (const [event, raw] of Object.entries(groups)) {
    if (strict && qwenHookControls.has(event)) continue;
    const next: unknown[] = [];
    for (const value of raw as unknown[]) {
      const group = object(value); let removed = false;
      const handlers = (group.hooks as unknown[]).filter(h => {
        const row = hook(event, group, h, strict), n = row && (remaining.get(row.id) ?? 0);
        if (!row || !n) return true; remaining.set(row.id, n - 1); removed = true; return false;
      });
      if (handlers.length || !removed) next.push({ ...group, hooks: handlers });
    }
    if (!next.length && object(b.hooks ?? {})[event] === undefined) delete groups[event]; else groups[event] = next;
  }
  if (!Object.keys(groups).length && b.hooks === undefined) delete c.hooks; else if (c.hooks !== undefined) c.hooks = groups;
  return finishJson(c, current, before);
}
function kimiHooks(image: ConfigImage): Record<string, unknown>[] {
  const value = toml(image).hooks ?? []; if (!Array.isArray(value)) throw Error("Kimi hooks must be an array"); return value.map(object);
}
const kimiKey = (row: Record<string, unknown>) => JSON.stringify([row.event, row.command, matcher(row.matcher), row.timeout]);
function restoreKimi(before: ConfigImage, after: ConfigImage, current: ConfigImage): ConfigImage {
  const b = kimiHooks(before), a = kimiHooks(after), c = kimiHooks(current), ours = added(b, a, kimiKey);
  for (const row of ours) {
    const at = c.findIndex(value => kimiKey(value) === kimiKey(row));
    if (at >= 0) c.splice(at, 1);
    else if (c.some(value => value.command === row.command && !b.some(old => kimiKey(old) === kimiKey(value)))) throw Error("setup-owned Kimi hook changed; refusing to overwrite it");
  }
  if (isDeepStrictEqual(c, kimiHooks(current))) return current;
  const original = toml(before);
  const value = !c.length && original.hooks === undefined ? undefined : c;
  const result = value === undefined ? setTomlPath(text(current), ["hooks"], undefined) : updateTomlArray(text(current), ["hooks"], value);
  if (before.bytes === null && Object.keys(object(Bun.TOML.parse(result))).length === 0) return { ...before, mode: current.mode };
  return rendered(result, current);
}
function restoreMcpOwned(target: string, before: ConfigImage, after: ConfigImage, current: ConfigImage): ConfigImage {
  const b = mcpRecord(target, before), a = mcpRecord(target, after), c = mcpRecord(target, current);
  if (isDeepStrictEqual(c, b) && !(target === "codex" && b === undefined && toml(before).mcp_servers === undefined && toml(current).mcp_servers !== undefined && Object.keys(object(toml(current).mcp_servers)).length === 0)) return current;
  if (c !== undefined && !isDeepStrictEqual(c, a)) throw Error("setup-owned MCP entry changed; refusing to overwrite it");
  let result = putMcpRecord(target, current, b);
  if (target === "codex" && b === undefined && toml(before).mcp_servers === undefined && Object.keys(object(toml(result).mcp_servers ?? {})).length === 0) result = rendered(setTomlPath(text(result), ["mcp_servers"], undefined), current);
  if (target !== "codex" && json(before).mcpServers !== undefined && json(result).mcpServers === undefined) { const value = json(result); value.mcpServers = {}; result = rendered(JSON.stringify(value, null, 2) + "\n", current); }
  if (result.bytes === null && before.bytes !== null) return target === "codex" ? rendered("", current) : finishJson({}, current, before);
  if (before.bytes === null && Object.keys(target === "codex" ? toml(result) : json(result)).length === 0) return { ...before, mode: current.mode };
  return result;
}
/** Exact restore when untouched; otherwise reverse only this receipt's managed entry/rows. */
export function restoreOwned(target: string, index: number, before: ConfigImage, after: ConfigImage, current: ConfigImage): ConfigImage {
  if (target === "agy" && index === 0) return restoreAgyMcp(before, after, current);
  if (target === "opencode" && index === 0) return restoreOpencodeMcp(before, after, current);
  if (target === "jcode" && index === 0) return restoreJcodeMcp(before, after, current);
  if (target === "jcode" && index === 1) return restoreJcodeHooks(before, after, current);
  if (sameImage(current, after)) return before;
  if (sameImage(current, before)) return current;
  // Qwen keeps both managed surfaces in one settings file and one receipt image.
  if (target === "qwen" && index === 0) return restoreJsonHooks(before, after, restoreMcpOwned(target, before, after, current), true);
  if (index === 0) return restoreMcpOwned(target, before, after, current);
  if (target === "claude" || target === "codex") return restoreJsonHooks(before, after, current);
  if (target === "kimi") return restoreKimi(before, after, current);
  if (current.bytes === after.bytes) return { ...before, mode: current.mode };
  if (current.bytes === before.bytes) return current;
  throw Error("setup-owned Pi extension changed; refusing to overwrite it");
}
export function managedAfter(target: string, index: number, before: ConfigImage, after: ConfigImage, current: ConfigImage): boolean {
  if (target === "qwen" && index === 0) {
    const needed = added(hooks(json(before), true), hooks(json(after), true), row => row.id), live = hooks(json(current), true);
    return isDeepStrictEqual(mcpRecord(target, after), mcpRecord(target, current)) && needed.every(row => live.some(value => value.id === row.id));
  }
  if (index === 0) return isDeepStrictEqual(mcpRecord(target, after), mcpRecord(target, current));
  if (target === "jcode") return jcodeHooksManaged(before, after, current);
  if (target === "claude" || target === "codex") {
    const needed = added(hooks(json(before)), hooks(json(after)), row => row.id), live = hooks(json(current));
    return needed.every(row => live.some(value => value.id === row.id));
  }
  if (target === "kimi") return added(kimiHooks(before), kimiHooks(after), kimiKey).every(row => kimiHooks(current).some(value => kimiKey(value) === kimiKey(row)));
  return current.bytes === after.bytes;
}

/** Read-only receipt diagnostics; use the same hook identity rules as semantic undo. */
export function managedHookEntries(target: string, before: ConfigImage, after: ConfigImage, current: ConfigImage,
  expected: readonly { event: string; command: string }[]): { entry: string; present: boolean }[] {
  if (target === "kimi") {
    const original = kimiHooks(before), installed = kimiHooks(after), live = kimiHooks(current);
    const ours = new Set(added(original, installed, kimiKey).map(kimiKey));
    return installed.filter(row => ours.has(kimiKey(row)) || expected.some(value => value.event === row.event && value.command === row.command))
      .map(row => ({ entry: `hooks.${String(row.event)}`, present: live.some(value => kimiKey(value) === kimiKey(row)) }));
  }
  const strict = target === "qwen", original = hooks(json(before), strict), installed = hooks(json(after), strict), live = hooks(json(current), strict);
  const ours = new Set(added(original, installed, row => row.id).map(row => row.id));
  return installed.filter(row => ours.has(row.id) || expected.some(value => value.event === row.event && value.command === row.command))
    .map(row => ({ entry: `hooks.${row.event}`, present: live.some(value => value.id === row.id) }));
}
