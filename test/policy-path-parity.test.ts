import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import baseline from "./fixtures/policy-path-before-dedupe.json";
import { policyPathCases } from "./fakes/policy-path-cases.ts";
import { createStandalonePolicy } from "../src/memory/policy.ts";

test("path deduplication matches the frozen pre-change screen on repeated, distinct, folded and bounded inputs", async () => {
  const cases = policyPathCases();
  expect(createHash("sha256").update(JSON.stringify(cases)).digest("hex")).toBe(baseline.corpusSha256);
  const hostOrder: string[] = []; let current = "";
  const policy = createStandalonePolicy({ ...baseline.options, host: { screen: async () => { hostOrder.push(current); return true; } } });
  const results: { name: string; allow: boolean }[] = [];
  for (const sample of cases) { current = sample.name; results.push({ name: sample.name, allow: await policy.screen(sample.value) }); }
  expect(results).toEqual(baseline.results);
  expect(hostOrder).toEqual(baseline.hostCallOrder);
});
