import { expect, test } from "bun:test";
import { requestedNodeMatcher } from "../src/memory/intent-node-matcher.ts";
import { planNodesIntersect } from "../src/memory/plan-guard.ts";

test("requested-node index matches planNodesIntersect for exact, directory and symbol forms", () => {
  const nodes = ["path:src", "path:src/a.ts", "path:src/sub", "path:src/sub/b.ts", "path:src//odd", "path:alpha", "symbol:read@src/a.ts", "symbol:read()@src/a.ts", "symbol:read@src/sub/b.ts", "symbol:other@src/a.ts", "symbol:bare", "symbol:section α@src/sub/b.ts", "symbol:source β@src/a.ts", "symbol:x@y@src/a.ts", "path:src/dir/", "other:literal"];
  const inputs = ["path:src", "path:src/", "path:src/a.ts", "path:src/sub", "path:src/sub/b.ts", "path:src/sub/b.ts/child", "path:src//odd", "path:src2", "path:alpha/beta", "path:", "symbol:read@src/a.ts", "symbol:read(x)@src/a.ts", "symbol:read@src/sub/b.ts", "symbol:other@src/a.ts", "symbol:bare", "symbol:bare()", "symbol:unknown@src/a.ts", "symbol:section α@src/sub/b.ts", "symbol:source β()@src/a.ts", "symbol:x@y@src/a.ts", "path:src/dir//child", "other:literal", "other:unknown"];
  const score = requestedNodeMatcher(nodes);
  for (const first of inputs) for (const second of inputs) {
    const about = [first, second];
    const expected = Math.min(3, nodes.filter(node => about.some(value => planNodesIntersect(node, value))).length);
    expect(score(about), JSON.stringify(about)).toBe(expected);
  }
});

test("four or more matches share the capped score", () => {
  const score = requestedNodeMatcher(["path:a", "path:b", "path:c", "path:d"]);
  expect(score(["path:a", "path:b", "path:c", "path:d"])).toBe(3);
  expect(score(["path:a", "path:b"])).toBe(2);
});

test("counting stops at three matches without inspecting the remaining nodes", () => {
  const score = requestedNodeMatcher(["path:a", "path:b", "path:c", "path:d"]);
  let reads = 0;
  const about = new Proxy(["path:a", "path:b", "path:c", "path:d"], {
    get(target, key, receiver) { if (typeof key === "string" && /^\d+$/.test(key)) reads++; return Reflect.get(target, key, receiver); },
  });
  expect(score(about)).toBe(3); expect(reads).toBe(3);
  expect(requestedNodeMatcher([])(about)).toBe(0);
});
