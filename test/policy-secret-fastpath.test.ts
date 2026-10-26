import { expect, test } from "bun:test";
import { createStandalonePolicy } from "../src/memory/policy.ts";
import { createStandalonePolicy as before } from "./fakes/policy-before-g1f.ts";

test("second-secret skip matches the pre-change screen for quoted, unquoted and split secrets", async () => {
  const suffix = "a".repeat(35);
  const values: unknown[] = ["ordinary prose ".repeat(100), "public 'quoted' note", 'public "quoted" note', "ghp_" + suffix,
    "gh'p_" + suffix, 'g"hp_' + suffix, "pass'word = abcdefghijklmnopqrstuvwxyz", '{"password":"abcdefghijklmnop"}',
    "-----BEGIN RSA PRIVATE KEY-----", "-----BE'GIN RSA PRIVATE KEY-----", { api_key: "sensitivevalue123" },
    { nested: { pass: "public", word: "public" } }, { excerpt: "path 'src/public.ts'" }];
  const oldCalls: number[] = [], newCalls: number[] = []; let current = 0;
  const old = before({ host: { screen: async () => { oldCalls.push(current); return current % 4 !== 0; } } });
  const next = createStandalonePolicy({ host: { screen: async () => { newCalls.push(current); return current % 4 !== 0; } } });
  for (const [index, value] of values.entries()) {
    current = index;
    for (let repeat = 0; repeat < 2; repeat++) expect(await next.screen(value)).toBe(await old.screen(value));
  }
  expect(newCalls).toEqual(oldCalls);
});
