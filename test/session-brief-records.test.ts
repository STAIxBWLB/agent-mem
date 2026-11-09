import { afterEach, expect, test } from "bun:test";
import { CaptureStore } from "../src/memory/capture.ts";
import { buildCaptureBriefCache } from "../src/brief-capture.ts";
import { processSignature } from "../src/memory/platform.ts";
import { sessionStartBrief } from "../src/session-brief.ts";
import { hookFixture } from "./fakes/hooks-fixture.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const f = hookFixture(); cleanup.push(f.close);
  const store = new CaptureStore({ memoryDir: f.base, project: f.project }); let n = 0;
  const append = (excerpt: string, event = "Record", extra: { paths?: string[]; subagent?: boolean } = {}) => store.append({
    project: f.project, agent: "claude", event, excerpt, paths: ["src/a.ts"], at: new Date(Date.now() - 60_000 + n++).toISOString(), ...extra,
  });
  cleanup.push(() => store.close());
  const options = { cwd: f.cwd, base: f.base, project: f.project, maxTokens: 8000, measureOnly: {}, timeRemaining: () => 2000 };
  return { ...f, append, options,
    prepare: () => buildCaptureBriefCache(store, { base: f.base, project: f.project, cwd: f.cwd, builtThrough: store.briefCommitId }),
  };
}
function lines(context: string): { event: string; excerpt: string; paths: string[] }[] {
  return context.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line))
    .filter(line => line.section === "capture").map(line => line.data);
}

test("five recent anchored main-session records lead summaries and raw rows, with no sixth Record fallback", async () => {
  const f = fixture();
  for (let n = 0; n < 6; n++) f.append(`amem: finding | src/a.ts | fact ${n}`);
  f.append("summary", "Recap"); f.append("raw", "PostToolUse");
  const result = await sessionStartBrief(f.options), rows = lines(result.context);
  expect(rows.slice(0, 5).map(row => row.excerpt)).toEqual([5, 4, 3, 2, 1].map(n => `amem: finding | src/a.ts | fact ${n}`));
  expect(rows.slice(5).map(row => row.event)).toEqual(["Recap", "PostToolUse"]);
  expect(result.context).not.toContain("fact 0");
  expect(result.coverage.capture).toBe("partial");
});

test("project-bound anchorless decisions/contracts enter the brief but invalid or subagent records stay out", async () => {
  const f = fixture();
  f.append("amem: finding | src/a.ts | allowed");
  f.append("amem: finding | src/a.ts | subagent", "Record", { subagent: true });
  f.append("amem: decision | - | project decision", "Record", { paths: [] });
  f.append("amem: contract | - | project contract", "Record", { paths: [] });
  f.append("amem: fix | - | invalid anchorless -> fix", "Record", { paths: [] });
  f.append("amem: finding | src/a.ts | mismatched", "Record", { paths: ["src/b.ts"] });
  f.append("unstructured excerpt"); f.append("raw allowed", "PostToolUse");
  const result = await sessionStartBrief(f.options);
  expect(lines(result.context).map(row => row.excerpt)).toEqual([
    "amem: contract | - | project contract", "amem: decision | - | project decision", "amem: finding | src/a.ts | allowed", "raw allowed",
  ]);
});

test("whole-row policy is applied before a Record receives brief priority", async () => {
  const f = fixture();
  f.append("amem: finding | src/a.ts | permitted"); f.append("amem: finding | src/a.ts | refused");
  const result = await sessionStartBrief({ ...f.options, policy: { host: { screen: async value => !JSON.stringify(value).includes("refused") } } });
  expect(lines(result.context).map(row => row.excerpt)).toEqual(["amem: finding | src/a.ts | permitted"]);
});

test("Record bytes take priority over raw captures without exceeding the same brief ceiling", async () => {
  const f = fixture();
  f.append("amem: fix | src/a.ts | race -> serialize writes");
  for (let n = 0; n < 4; n++) f.append(`raw-${n}: ` + "x".repeat(230), "PostToolUse");
  const result = await sessionStartBrief({ ...f.options, maxTokens: 500 });
  expect(result.tokens).toBe(Buffer.byteLength(result.context));
  expect(result.tokens).toBeLessThanOrEqual(500);
  expect(lines(result.context)[0]?.excerpt).toBe("amem: fix | src/a.ts | race -> serialize writes");
  expect(lines(result.context).filter(row => row.event === "PostToolUse")).toHaveLength(0);
});

test("native cache preserves canonical Record-before-summary placement without raw fill", async () => {
  const f = fixture();
  f.append("amem: finding | src/a.ts | native record");
  f.append("native summary", "Recap"); f.append("native raw", "PostToolUse");
  f.prepare();
  const result = await sessionStartBrief({ cwd: f.cwd, base: f.base, project: f.project, maxTokens: 1200,
    nativeSession: { signature: processSignature(process.pid)! }, timeRemaining: () => 70 });
  expect(lines(result.context).map(row => row.excerpt)).toEqual(["amem: finding | src/a.ts | native record", "native summary"]);
  expect(result.context).not.toContain("native raw");
});
