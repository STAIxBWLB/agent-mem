import { expect, test } from "bun:test";
import { createStandalonePolicy } from "../src/memory/policy.ts";
import { createStandalonePolicy as before } from "./fakes/policy-before-g1f.ts";

test("email skip matches the pre-change screen and fresh host calls", async () => {
  const values: unknown[] = ["ordinary prose ".repeat(100), "학생 공개 기록", "@", "a@b", "x".repeat(319) + "@", "x".repeat(320) + "@",
    "person@example.invalid", "<person@example.invalid>", "PERSON＠EXAMPLE.INVALID", "123-45-6789", "900101-1234567",
    "public: @ marker", { excerpt: "ordinary no-at text", nested: ["public"] }, { contact: "person@example.invalid" }];
  const oldCalls: number[] = [], newCalls: number[] = []; let current = 0;
  const old = before({ host: { screen: async () => { oldCalls.push(current); return current % 5 !== 0; } } });
  const next = createStandalonePolicy({ host: { screen: async () => { newCalls.push(current); return current % 5 !== 0; } } });
  for (const [index, value] of values.entries()) {
    current = index;
    for (let repeat = 0; repeat < 2; repeat++) expect(await next.screen(value)).toBe(await old.screen(value));
  }
  expect(newCalls).toEqual(oldCalls);
});
