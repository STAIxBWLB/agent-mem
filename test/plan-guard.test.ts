import { expect, test } from "bun:test";
import { matchingPlanFails, normalizeMemorySymbolInput, planGuardNodes, planNodesIntersect } from "../src/memory/plan-guard.ts";
const context = { cwd: "/unopened/repo", project: "project", repo: "org/repo" };
test("explicit inputs are extracted separately beyond the per-note 64 node cap without filesystem probes", () => {
  const paths = Array.from({ length: 150 }, (_, i) => `src/part${i}.ts`), nodes = planGuardNodes({ paths }, context);
  expect(nodes).toHaveLength(150); expect(nodes).toContain("path:src/part149.ts");
  expect(planGuardNodes({ paths: ["missing.ts"], symbols: ["Writer.run(arg: string)"] }, context)).toEqual(["path:missing.ts", "symbol:Writer.run(arg: string)@missing.ts", "symbol:Writer.run@missing.ts"]);
});
test("symbol signatures retain explicit file suffixes and name identity", () => {
  expect(normalizeMemorySymbolInput("Writer.run(arg: string)@src/a.ts")).toBe("Writer.run@src/a.ts");
  expect(planGuardNodes({ symbols: ["Writer.run(args)@./src/../writer.ts"] }, context)).toEqual(["symbol:Writer.run(args)@writer.ts", "symbol:Writer.run@writer.ts"]);
  expect(normalizeMemorySymbolInput("section notes(arguments)")).toBe("section notes(arguments)");
  expect(planNodesIntersect("symbol:Writer.run(x)@src/a.ts", "symbol:Writer.run@src/a.ts")).toBe(true);
  expect(planNodesIntersect("symbol:Writer.run@src/a.ts", "symbol:Other.run@src/a.ts")).toBe(false);
  expect(planNodesIntersect("symbol:Writer.run@src/a.ts", "symbol:Writer.run@src/b.ts")).toBe(false);
});
test("path scope intersects whole components, including symbol defining paths", () => {
  expect(planNodesIntersect("path:src/api", "path:src/api/handler.ts")).toBe(true);
  expect(planNodesIntersect("path:src/api", "symbol:serve@src/api/handler.ts")).toBe(true);
  expect(planNodesIntersect("path:src/api", "path:src/apis/handler.ts")).toBe(false);
  expect(planNodesIntersect("path:src/api", "path:other/src/api")).toBe(false);
});
test("hub-shaped structural task adapter has parity with converted standalone input", () => {
  const task = { title: "repair writer", refs: { paths: ["src/write.ts"] }, plan: { paths: ["src/store.ts"], symbols: ["Store.put(args)@src/store.ts"] } };
  const converted = { paths: [...task.refs.paths, ...task.plan.paths], symbols: task.plan.symbols };
  const notes: Array<{ kind: "fail" | "decision"; about: string[]; supersededBy: string | null }> = [{ kind: "fail", about: ["symbol:Store.put@src/store.ts"], supersededBy: null }, { kind: "fail", about: ["path:other"], supersededBy: null }, { kind: "fail", about: ["path:src"], supersededBy: "replacement" }, { kind: "decision", about: ["path:src/store.ts"], supersededBy: null }];
  expect(planGuardNodes(task, context)).toEqual(planGuardNodes(converted, context));
  expect(matchingPlanFails(task, notes, context)).toEqual([notes[0]!]); expect(matchingPlanFails(converted, notes, context)).toEqual([notes[0]!]);
});
test("deny paths, traversal and absolute inputs do not become plan nodes", () => {
  const nodes = planGuardNodes({ paths: ["../outside.ts", "/private/x.ts", "secrets/key.ts"], symbols: ["read@secrets/key.ts", "read@../outside.ts"] }, { ...context, deny: ["secrets/"] });
  expect(nodes).toEqual([]);
});

test("explicit expired or invalid expiry fail notes never match a live plan guard", () => {
  const base = { kind: "fail" as const, about: ["path:src/write.ts"], supersededBy: null }, now = Date.parse("2026-10-25T00:00:00.000Z");
  const rows = [{ ...base, expiresAt: new Date(now).toISOString() }, { ...base, expiresAt: "invalid" }, { ...base, expiresAt: new Date(now + 1).toISOString() }];
  expect(matchingPlanFails({ paths: ["src/write.ts"] }, rows, { ...context, now: () => now })).toEqual([rows[2]!]);
});
