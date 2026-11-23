import { expect, test } from "bun:test";
import { commandHelp } from "../src/commands-table.ts";
import { statusText, type StatusView } from "../src/memory/status-text.ts";
import { ROLE_SGR, SGR_RESET } from "@staix/cli-output";
import { style } from "../src/memory/style.ts";

const fixture: StatusView = { home: { path: "/fixture/memory", source: "fixture" },
  config: { machine: null, repo: null, denyPaths: 0, piiPatterns: 0 },
  candidates: { count: 0, oldestExpiresInDays: null, dueWithin7Days: 0, unshown: 0 },
  active: false, pending: { rows: 0 } };

test("main report golden: plain and semantic color", () => {
  const plain = statusText(fixture, style(false, true));
  expect(plain).toBe(" amem status  ok\n  home /fixture/memory (fixture)\n\n> Memory\n  ok ok  policy:      machine none (defaults), repo none, 0 deny paths, 0 PII patterns\n  ok ok  candidates:  none pending\n  ok ok  layout:      single home; no pending old-layout appends");
  const color = statusText(fixture, style(true, false));
  expect(color).toStartWith(`${ROLE_SGR.header} amem status${SGR_RESET}`);
  expect(color).toContain(`${ROLE_SGR.section}▸ Memory${SGR_RESET}`);
  expect(color).toContain(`${ROLE_SGR.success}✓ ${SGR_RESET}`);
});

test("status and overview fit 80 cells when wrapping is requested", () => {
  for (const text of [statusText(fixture, style(false, true), { columns: 80 }), commandHelp()]) {
    for (const line of text.split("\n")) expect(Bun.stringWidth(line, { ambiguousIsNarrow: true })).toBeLessThanOrEqual(80);
  }
});
