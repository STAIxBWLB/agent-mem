import type { ConfigImage } from "./setup-owned.ts";
import { createJsonMcpCodec } from "./setup-json.ts";
import { setTomlPath } from "./setup-toml.ts";

const codec = createJsonMcpCodec({ canonicalKey: "servers", aliases: ["mcpServers"], label: "Jcode" });
export function readJcodeMcp(image: ConfigImage): unknown { return codec.read(image); }
export function putJcodeMcp(image: ConfigImage, value: unknown): ConfigImage { return codec.put(image, value); }
export function restoreJcodeMcp(before: ConfigImage, after: ConfigImage, current: ConfigImage): ConfigImage { return codec.restore(before, after, current); }

// #203: jcode v0.99.1 `[hooks]` in <JCODE_HOME>/config.toml (crates/jcode-config-types HooksConfig). Each event accepts a
// command string or an ordered array of strings; observers in an array all run. amem owns only its own command element.
export const JCODE_CAPTURE_EVENTS = ["post_tool", "turn_end"] as const;
const tomlText = (image: ConfigImage) => image.bytes === null ? "" : new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(image.bytes, "base64"));
const tomlImage = (value: string, mode: number): ConfigImage => ({ bytes: Buffer.from(value).toString("base64"), mode });
function hooksTable(text: string): Record<string, unknown> | undefined {
  let document: unknown;
  try { document = Bun.TOML.parse(text); } catch { throw Error("Jcode config.toml does not parse as TOML"); }
  const hooks = (document as Record<string, unknown>).hooks;
  if (hooks === undefined) return undefined;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) throw Error("Jcode [hooks] must be a table");
  return hooks as Record<string, unknown>;
}
function commands(value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value === "string") return value.trim() ? [value] : [];
  if (Array.isArray(value) && value.every(item => typeof item === "string")) return value as string[];
  throw Error("Jcode hook commands must be a string or an array of strings");
}
/** Adds `command` to each capture event, keeping any existing user command ahead of it (array form). */
export function putJcodeHooks(before: ConfigImage, command: string): ConfigImage {
  let text = tomlText(before);
  const hooks = hooksTable(text) ?? {};
  for (const event of JCODE_CAPTURE_EVENTS) {
    const existing = commands(hooks[event]);
    if (existing.includes(command)) continue;
    text = setTomlPath(text, ["hooks", event], existing.length ? [...existing, command] : command);
  }
  return tomlImage(text, before.mode);
}
/** amem's command elements, per event, that `after` added over `before` (the receipt proves ownership, not the runtime). */
function ownedCommands(before: ConfigImage, after: ConfigImage): Map<string, string[]> {
  const b = hooksTable(tomlText(before)) ?? {}, a = hooksTable(tomlText(after)) ?? {}, owned = new Map<string, string[]>();
  for (const event of JCODE_CAPTURE_EVENTS) { const prior = commands(b[event]); owned.set(event, commands(a[event]).filter(item => !prior.includes(item))); }
  return owned;
}
export function jcodeHooksManaged(before: ConfigImage, after: ConfigImage, current: ConfigImage): boolean {
  try { const hooks = hooksTable(tomlText(current)) ?? {}; return [...ownedCommands(before, after)].every(([event, owned]) => owned.every(item => commands(hooks[event]).includes(item))); }
  catch { return false; }
}
/** Exact restore when untouched; otherwise removes only amem's command elements, keeping user commands and later edits. */
export function restoreJcodeHooks(before: ConfigImage, after: ConfigImage, current: ConfigImage): ConfigImage {
  if (current.bytes === after.bytes) return { ...before, mode: current.mode };
  if (current.bytes === before.bytes) return current;
  const original = hooksTable(tomlText(before)) ?? {}, owned = ownedCommands(before, after);
  let text = tomlText(current);
  const hooks = hooksTable(text) ?? {};
  for (const event of JCODE_CAPTURE_EVENTS) {
    const live = commands(hooks[event]), mine = owned.get(event) ?? [];
    if (!live.some(item => mine.includes(item))) continue;
    const kept = live.filter(item => !mine.includes(item)), prior = original[event];
    // Return the user's original spelling when only amem's element was added; otherwise keep the remaining array.
    const value = !kept.length ? (prior !== undefined && !commands(prior).length ? prior : undefined)
      : kept.length === 1 && typeof prior === "string" && prior === kept[0] ? prior : kept;
    text = setTomlPath(text, ["hooks", event], value);
  }
  if (hooksTable(tomlText(before)) === undefined) {
    const left = hooksTable(text);
    if (left !== undefined && !Object.keys(left).length) text = setTomlPath(text, ["hooks"], undefined);
  }
  if (before.bytes === null && !Object.keys(Bun.TOML.parse(text) as object).length) return { ...before, mode: current.mode };
  return tomlImage(text, current.mode);
}
