import { normalizeMemorySymbolInput } from "./plan-guard.ts";
import { nodePath } from "./project.ts";

type PathIndex = { exact: Map<string, number[]>; descendants: Map<string, number[]> };
const index = (): PathIndex => ({ exact: new Map(), descendants: new Map() });
function add(map: Map<string, number[]>, key: string, id: number): void {
  const prior = map.get(key); if (prior) prior.push(id); else map.set(key, [id]);
}
/** Requested nodes only: no note, policy or other row contributes to this index. */
export function requestedNodeMatcher(nodes: readonly string[]): (about: readonly string[]) => number {
  const literal = new Map<string, number[]>(), symbols = new Map<string, number[]>();
  const paths = index(), symbolPaths = index();
  for (let id = 0; id < nodes.length; id++) {
    const node = nodes[id]!; add(literal, node, id);
    const symbol = node.startsWith("symbol:");
    if (symbol) add(symbols, normalizeMemorySymbolInput(node.slice(7)), id);
    const path = nodePath(node); if (!path) continue;
    const target = symbol ? symbolPaths : paths;
    add(target.exact, path, id);
    for (let pos = path.indexOf("/"); pos >= 0; pos = path.indexOf("/", pos + 1)) {
      const prefix = path.slice(0, pos); if (prefix) add(target.descendants, prefix, id);
    }
  }
  // ponytail: retain at most 1,024 short node lookups and 256 KiB of key text per call. A bounded LRU or a
  // shared immutable query index is the upgrade if diverse large notes make this small cache ineffective.
  const cache = new Map<string, readonly number[]>(); let cachedBytes = 0;
  const marks = new Uint32Array(nodes.length); let epoch = 0;
  const indices = (node: string): readonly number[] => {
    const known = cache.get(node); if (known) return known;
    const result: number[] = [];
    const addIds = (ids?: readonly number[]) => { if (ids) for (const id of ids) result.push(id); };
    const addPaths = (target: PathIndex, path: string) => {
      addIds(target.exact.get(path)); addIds(target.descendants.get(path));
      for (let pos = path.indexOf("/"); pos >= 0; pos = path.indexOf("/", pos + 1)) {
        const prefix = path.slice(0, pos); if (prefix) addIds(target.exact.get(prefix));
      }
    };
    addIds(literal.get(node));
    const symbol = node.startsWith("symbol:");
    if (symbol) addIds(symbols.get(normalizeMemorySymbolInput(node.slice(7))));
    const path = nodePath(node); if (path) { addPaths(paths, path); if (!symbol) addPaths(symbolPaths, path); }
    const bytes = node.length * 2;
    if (node.length <= 512 && cache.size < 1024 && cachedBytes + bytes <= 256 * 1024) { cache.set(node, result); cachedBytes += bytes; }
    return result;
  };
  const limit = Math.min(nodes.length, 3);
  return about => {
    if (!limit) return 0;
    epoch++; if (epoch === 0xffffffff) { marks.fill(0); epoch = 1; }
    let count = 0;
    for (let at = 0; at < about.length; at++) {
      const node = about[at]!;
      let known = cache.get(node);
      if (known === undefined) {
        if (typeof node !== "string") throw Error("invalid intent node");
        known = indices(node);
      }
      for (let i = 0; i < known.length; i++) { const id = known[i]!; if (marks[id] !== epoch) { marks[id] = epoch; if (++count === limit) return count; } }
    }
    return count;
  };
}
