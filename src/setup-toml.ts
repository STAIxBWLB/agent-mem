import { isDeepStrictEqual } from "node:util";

export const SETUP_CONFIG_BYTES = 8 * 1024 * 1024;
const MAX_NODES = 65536, MAX_DEPTH = 32;
const temporal = new Set(["[object Temporal.Instant]", "[object Temporal.PlainDate]", "[object Temporal.PlainTime]", "[object Temporal.PlainDateTime]"]);
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const prefix = (left: readonly string[], right: readonly string[]) => left.length <= right.length && left.every((key, index) => key === right[index]);
const error = (): never => { throw Error("setup TOML unavailable or unsupported; no configuration changed"); };
function parse(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text) > SETUP_CONFIG_BYTES) return error();
  try { const value: unknown = Bun.TOML.parse(text); return plain(value) ? value : error(); } catch { return error(); }
}
/** Compare Temporal values and nonfinite numbers explicitly rather than relying on enumerable object properties. */
function shape(value: unknown, depth = 0, count = { value: 0, bytes: 0 }, seen = new Set<object>()): unknown {
  if (depth > MAX_DEPTH || ++count.value > MAX_NODES) return error();
  if (typeof value === "string") { count.bytes += Buffer.byteLength(value); if (count.bytes > SETUP_CONFIG_BYTES) return error(); return ["string", value]; }
  if (typeof value === "boolean") return ["boolean", value];
  if (typeof value === "number") return ["number", Number.isNaN(value) ? "nan" : Object.is(value, -0) ? "-0" : String(value)];
  if (!value || typeof value !== "object" || seen.has(value)) return error();
  const tag = Object.prototype.toString.call(value);
  if (temporal.has(tag)) return [tag, String(value)];
  if (!Array.isArray(value) && !plain(value)) return error();
  if (Object.getOwnPropertySymbols(value).length) return error();
  seen.add(value);
  try {
    if (Array.isArray(value)) return ["array", Array.from({ length: value.length }, (_, index) => shape(value[index], depth + 1, count, seen))];
    return ["table", Object.keys(value).sort().map(key => {
      count.bytes += Buffer.byteLength(key); if (count.bytes > SETUP_CONFIG_BYTES) return error();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return error();
      return [key, shape(descriptor.value, depth + 1, count, seen)];
    })];
  } finally { seen.delete(value); }
}
function inline(value: unknown): string {
  shape(value);
  // Bun emits scalars and many arrays as one assignment. Reuse that literal when it is safe in this scope.
  // Objects/AOTs may become headers; those need the inline form below to avoid changing subsequent table scope.
  let rendered = "";
  try { rendered = Bun.TOML.stringify({ setup_value: value }); } catch { /* The validated inline encoder covers values the built-in writer cannot emit. */ }
  const literal = /^setup_value\s*=\s*([^\r\n]*)\r?\n?$/.exec(rendered)?.[1];
  if (literal !== undefined && isDeepStrictEqual(shape(parse(rendered).setup_value), shape(value))) return literal;
  const encode = (part: unknown): string => {
    if (typeof part === "string") return JSON.stringify(part);
    if (typeof part === "boolean") return String(part);
    if (typeof part === "number") return Number.isNaN(part) ? "nan" : part === Infinity ? "inf" : part === -Infinity ? "-inf" : Object.is(part, -0) ? "-0.0" : String(part);
    if (temporal.has(Object.prototype.toString.call(part))) return String(part);
    if (Array.isArray(part)) return `[${part.map(encode).join(", ")}]`;
    if (plain(part)) return `{ ${Object.keys(part).map(key => `${JSON.stringify(key)} = ${encode(part[key])}`).join(", ")} }`;
    return error();
  };
  return encode(value);
}
function at(document: Record<string, unknown>, path: readonly string[]): unknown {
  let value: unknown = document;
  for (const key of path) { if (!plain(value) || !Object.hasOwn(value, key)) return undefined; value = value[key]; }
  return value;
}
function edit(document: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let parent = document;
  for (const key of path.slice(0, -1)) {
    if (!Object.hasOwn(parent, key)) Object.defineProperty(parent, key, { value: Object.create(null), writable: true, configurable: true, enumerable: true });
    if (!plain(parent[key])) return error(); // String paths cannot identify one element of an array of tables.
    parent = parent[key] as Record<string, unknown>;
  }
  const key = path.at(-1)!;
  if (value === undefined) delete parent[key];
  else Object.defineProperty(parent, key, { value, writable: true, configurable: true, enumerable: true });
}
interface Statement { start: number; end: number; equal?: number; comment?: number; path: string[]; header: boolean; array: boolean }
/** Bun decodes quoted/dotted keys; the lexical scan below only locates complete statement boundaries. */
function keyPath(source: string, header: boolean): string[] {
  let value: unknown = parse(header ? source : `${source} = 0`); const keys: string[] = [];
  while (plain(value) && Object.keys(value).length === 1) {
    const key = Object.keys(value)[0]!; keys.push(key); value = value[key];
    if (Array.isArray(value)) { if (value.length !== 1) return error(); value = value[0]; }
  }
  if (!keys.length || header && (!plain(value) || Object.keys(value).length)) return error();
  return keys;
}
function statements(text: string): Statement[] {
  const out: Statement[] = []; let offset = 0, table: string[] = [];
  while (offset < text.length) {
    while (offset < text.length) {
      if (/\s/.test(text[offset]!)) { offset++; continue; }
      if (text[offset] === "#") { while (offset < text.length && text[offset] !== "\n") offset++; continue; }
      break;
    }
    if (offset >= text.length) break;
    const start = offset; let equal: number | undefined, comment: number | undefined, depth = 0, quote: string | undefined, multi = false;
    while (offset < text.length) {
      const char = text[offset]!;
      if (quote) {
        if (quote === '"' && char === "\\") { offset += Math.min(2, text.length - offset); continue; }
        if (char === quote) {
          let run = 1; while (text[offset + run] === quote) run++;
          if (!multi || run >= 3) { quote = undefined; offset += multi ? run : 1; multi = false; continue; }
          offset += run; continue;
        }
        offset++; continue;
      }
      if (char === '"' || char === "'") { quote = char; multi = text.slice(offset, offset + 3) === char.repeat(3); offset += multi ? 3 : 1; continue; }
      if (char === "#") {
        if (depth === 0) comment = offset;
        while (offset < text.length && text[offset] !== "\n") offset++;
        if (depth === 0) { if (offset < text.length) offset++; break; } continue;
      }
      if (char === "[" || char === "{") depth++;
      else if (char === "]" || char === "}") depth--;
      else if (char === "=" && depth === 0 && equal === undefined) equal = offset;
      if (depth < 0 || depth > MAX_DEPTH) return error();
      offset++;
      if (char === "\n" && depth === 0) break;
    }
    if (quote || depth !== 0 || out.length >= MAX_NODES) return error();
    const header = text[start] === "[", array = header && text[start + 1] === "[";
    if (header) table = keyPath(text.slice(start, comment ?? offset).trim(), true);
    else if (equal === undefined) return error();
    out.push({ start, end: offset, equal, comment, path: header ? [...table] : [...table, ...keyPath(text.slice(start, equal), false)], header, array });
  }
  return out;
}
interface Replacement { start: number; end: number; text: string }
function replace(text: string, changes: Replacement[]): string {
  for (const change of changes.sort((a, b) => b.start - a.start || b.end - a.end)) text = text.slice(0, change.start) + change.text + text.slice(change.end);
  return text;
}
/**
 * Change one configuration subtree while preserving other statements/comments byte-for-byte.
 * ponytail: <=8 MiB, depth32 and string table paths only. Array-element editing requires a richer host API;
 * unsupported layouts/values refuse after Bun parse/semantic verification, never fall back to rewriting the document.
 */
export function setTomlPath(text: string, path: readonly string[], value: unknown | undefined): string {
  return editTomlPath(text, path, value);
}
function editTomlPath(text: string, path: readonly string[], value: unknown | undefined, eol = text.includes("\r\n") ? "\r\n" : "\n"): string {
  if (!path.length || path.length > 8 || path.some(key => typeof key !== "string" || Buffer.byteLength(key) > 256 || /[\p{Cc}\p{Cf}]/u.test(key))) return error();
  const original = parse(text), current = at(original, path);
  shape(original);
  let parent: unknown = original;
  for (const key of path.slice(0, -1)) {
    if (!plain(parent)) return error();
    if (!Object.hasOwn(parent, key)) break;
    parent = parent[key]; if (!plain(parent)) return error();
  }
  if (value === undefined && current === undefined || value !== undefined && current !== undefined && isDeepStrictEqual(shape(current), shape(value))) return text;
  if (value !== undefined) shape(value);
  const expected = parse(text); edit(expected, path, value); shape(expected);
  const units = statements(text), ancestor = units.find(unit => !unit.header && prefix(unit.path, path));
  let output: string;
  if (ancestor) {
    const replacement = at(expected, ancestor.path);
    const suffix = ancestor.comment !== undefined ? " " + text.slice(ancestor.comment, ancestor.end) : /\r?\n$/.exec(text.slice(ancestor.start, ancestor.end))?.[0] ?? "";
    output = replace(text, [{ start: ancestor.start, end: ancestor.end, text: replacement === undefined ? "" : `${text.slice(ancestor.start, ancestor.equal! + 1)} ${inline(replacement)}${suffix}` }]);
  } else {
    const changes: Replacement[] = units.filter(unit => prefix(path, unit.path)).map(unit => ({ start: unit.start, end: unit.end, text: "" }));
    if (value !== undefined) {
      const parent = units.filter(unit => unit.header && !unit.array && unit.path.length < path.length && prefix(unit.path, path)).sort((a, b) => b.path.length - a.path.length)[0];
      const position = parent?.end ?? units.find(unit => unit.header)?.start ?? text.length;
      const key = path.slice(parent?.path.length ?? 0).map(part => JSON.stringify(part)).join(".");
      const newline = position > 0 && text[position - 1] !== "\n" ? eol : "";
      changes.push({ start: position, end: position, text: `${newline}${key} = ${inline(value)}${eol}` });
    }
    output = replace(text, changes);
    // Removing the only child of an implicit table must retain its parsed empty parent value.
    for (let depth = path.length - 1; depth > 0; depth--) {
      const parent = path.slice(0, depth), wanted = at(expected, parent);
      if (plain(wanted) && !Object.keys(wanted).length && at(parse(output), parent) === undefined) output += `${output && !output.endsWith("\n") ? eol : ""}[${parent.map(part => JSON.stringify(part)).join(".")}]${eol}`;
    }
  }
  if (!isDeepStrictEqual(shape(parse(output)), shape(expected))) return error();
  return output;
}

function quotedEnd(text: string, start: number): number {
  const quote = text[start]!, multi = text.slice(start, start + 3) === quote.repeat(3); let offset = start + (multi ? 3 : 1);
  while (offset < text.length) {
    if (quote === '"' && text[offset] === "\\") { offset += 2; continue; }
    if (text[offset] === quote) {
      let run = 1; while (text[offset + run] === quote) run++;
      if (!multi || run >= 3) return offset + (multi ? run : 1);
      offset += run; continue;
    }
    offset++;
  }
  return error();
}
interface ArrayElement { start: number; end: number; removeFrom: number; comma?: number }
function arrayElements(text: string, open: number): { close: number; elements: ArrayElement[] } {
  if (text[open] !== "[") return error();
  let offset = open + 1; const elements: ArrayElement[] = [];
  while (offset < text.length) {
    let removeFrom = offset;
    while (offset < text.length) {
      if (/\s/.test(text[offset]!)) { offset++; continue; }
      if (text[offset] === "#") {
        while (offset < text.length && text[offset] !== "\n") offset++;
        // Trim indentation after a comment, but preserve its terminating newline.
        removeFrom = offset < text.length ? offset + 1 : offset; continue;
      }
      break;
    }
    if (text[offset] === "]") return { close: offset, elements };
    const start = offset; let end = offset, depth = 0;
    while (offset < text.length) {
      const char = text[offset]!;
      if (char === '"' || char === "'") { offset = quotedEnd(text, offset); end = offset; continue; }
      if (char === "#") { while (offset < text.length && text[offset] !== "\n") offset++; continue; }
      if (char === "," && depth === 0) { elements.push({ start, end, removeFrom, comma: offset }); offset++; break; }
      if (char === "]" && depth === 0) { elements.push({ start, end, removeFrom }); return { close: offset, elements }; }
      if (char === "[" || char === "{") depth++;
      else if (char === "]" || char === "}") depth--;
      if (depth < 0 || depth > MAX_DEPTH) return error();
      offset++; if (!/\s/.test(char)) end = offset;
    }
    if (elements.length > MAX_NODES) return error();
  }
  return error();
}
/** Keep an ordered subsequence of existing elements, optionally adding new elements only at the tail. */
function arrayEdit(before: readonly unknown[], after: readonly unknown[]): { keep: Set<number>; append: readonly unknown[] } {
  const old = before.map(value => JSON.stringify(shape(value))), next = after.map(value => JSON.stringify(shape(value)));
  const keep = new Set<number>(); let cursor = 0, tail = next.length;
  for (let i = 0; i < next.length; i++) {
    while (cursor < old.length && old[cursor] !== next[i]) cursor++;
    if (cursor === old.length) { tail = i; break; }
    keep.add(cursor++);
  }
  const removed = new Set(old.filter((_value, index) => !keep.has(index)));
  // A reorder must not masquerade as deleting an old element and appending its normalized serialization.
  if (next.slice(tail).some(value => removed.has(value))) return error();
  if (keep.size < before.length && tail < after.length) return error(); // Refuse replacement disguised as simultaneous remove/append.
  return { keep, append: after.slice(tail) };
}
function appendedTables(path: readonly string[], values: readonly unknown[], eol: string): string {
  if (!values.every(plain)) return error();
  const document: Record<string, unknown> = {}; edit(document, path, [...values]);
  let source: string; try { source = Bun.TOML.stringify(document); } catch { return error(); }
  const sourceUnits = statements(source), rows = sourceUnits.filter(unit => prefix(path, unit.path));
  if (rows.filter(unit => unit.header && unit.array && unit.path.length === path.length).length !== values.length) return error();
  return rows.map(unit => source.slice(unit.start, unit.end)).join("").replace(/\r?\n/g, eol);
}
/**
 * Append/remove an array subsequence without reserializing surviving elements or their comments/numeric spelling.
 * ponytail: exact array assignments and arrays of tables only; arrays nested inside inline parent tables and
 * simultaneous remove+append, element replacement and reordering refuse. Use setTomlPath for an explicitly authorized whole-subtree replacement.
 */
export function updateTomlArray(text: string, path: readonly string[], expectedArray: readonly unknown[]): string {
  if (!path.length || path.length > 8 || path.some(key => typeof key !== "string" || Buffer.byteLength(key) > 256 || /[\p{Cc}\p{Cf}]/u.test(key)) || !Array.isArray(expectedArray)) return error();
  const original = parse(text), current = at(original, path); shape(original); shape(expectedArray);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  if (current === undefined) return editTomlPath(text, path, [...expectedArray], eol);
  if (!Array.isArray(current)) return error();
  if (isDeepStrictEqual(shape(current), shape(expectedArray))) return text;
  const expected = parse(text); edit(expected, path, [...expectedArray]);
  const { keep, append } = arrayEdit(current, expectedArray), units = statements(text);
  const assignment = units.find(unit => !unit.header && unit.path.length === path.length && prefix(path, unit.path));
  const changes: Replacement[] = []; let output: string;
  if (assignment) {
    let open = assignment.equal! + 1; while (/\s/.test(text[open] ?? "")) open++;
    const array = arrayElements(text, open);
    if (array.elements.length !== current.length) return error();
    for (let index = 0; index < array.elements.length; index++) if (!keep.has(index)) {
      const element = array.elements[index]!; changes.push({ start: element.removeFrom, end: element.end, text: "" });
      if (element.comma !== undefined) changes.push({ start: element.comma, end: element.comma + 1, text: "" });
      else {
        // The last element has no comma of its own: drop the same-line comma that append inserted after the kept element before it, or `[a,]` remains. A comma followed by a comment or newline was the person's own and stays.
        const before = [...keep].filter(kept => kept < index).at(-1), previous = before === undefined ? undefined : array.elements[before];
        if (previous?.comma !== undefined && !append.length && /^[ \t]*$/.test(text.slice(previous.comma + 1, element.start))) changes.push({ start: previous.comma, end: previous.comma + 1, text: "" });
      }
    }
    if (append.length) {
      const last = [...keep].at(-1), element = last === undefined ? undefined : array.elements[last];
      const adjacentComma = element && element.comma === undefined && element.end === array.close ? "," : "";
      if (element && element.comma === undefined && !adjacentComma) changes.push({ start: element.end, end: element.end, text: "," });
      const multiline = text.slice(open, array.close).includes("\n"), indent = /(?:^|\n)([\t ]*)$/.exec(text.slice(open, array.close))?.[1] ?? "";
      changes.push({ start: array.close, end: array.close, text: `${adjacentComma} ${append.map(inline).join(multiline ? `,${eol}${indent}` : ", ")}${multiline ? eol + indent : ""}` });
    }
    output = replace(text, changes);
  } else {
    let index = -1, headers = 0;
    for (const unit of units) {
      if (unit.header && unit.array && unit.path.length === path.length && prefix(path, unit.path)) { index++; headers++; }
      if (prefix(path, unit.path)) {
        if (index < 0) return error();
        if (!keep.has(index)) changes.push({ start: unit.start, end: unit.end, text: "" });
      }
    }
    if (headers !== current.length) return error();
    output = replace(text, changes);
    if (append.length) output += `${output && !output.endsWith("\n") ? eol : ""}${appendedTables(path, append, eol)}`;
    if (!keep.size && !append.length) output = editTomlPath(output, path, [], eol);
  }
  if (!isDeepStrictEqual(shape(parse(output)), shape(expected))) return error();
  return output;
}
