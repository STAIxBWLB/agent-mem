import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatCliError, runCli, type CliContext } from "../src/cli.ts";
import { DecayApplyError } from "../src/memory/decay-review.ts";
import { realPath } from "../src/memory/platform.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { MemoryStore } from "../src/memory/store.ts";
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-decay-failure-cli-"))), base = join(root, "memory"), project = memoryProjectKey(root);
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const seed = new MemoryStore({ memoryDir: base, deferPromotions: true, now: () => Date.now() - 120 * 86400_000 });
  const ids = ["first", "second", "third"].map(name => seed.note({ op: "note", project, scope: "project", tier: "long", kind: "contract", peer: "person", source: "person", text: `${name} old public boundary`, about: [] })); seed.close();
  const use = <T>(work: (store: MemoryStore) => T): T => { const store = new MemoryStore({ memoryDir: base, deferPromotions: true }); try { return work(store); } finally { store.close(); } };
  const bytes = () => Object.fromEntries(readdirSync(base, { recursive: true, withFileTypes: true }).filter(row => row.isFile() && row.name.endsWith(".jsonl")).map(row => { const file = join(row.parentPath, row.name); return [file.slice(base.length), readFileSync(file, "utf8")]; }));
  const cli = async (args: string[], extra: Partial<CliContext> = {}) => {
    const previousHome = process.env.HOME, previousBase = process.env.AMEM_HOME; process.env.HOME = root; process.env.AMEM_HOME = base;
    try { return await runCli(args, { cwd: root, env: {}, stdinTTY: true, ...extra }); }
    finally { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; if (previousBase === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = previousBase; }
  };
  return { ids, project, use, bytes, cli };
}
for (const action of ["demote", "forget"] as const) for (const json of [false, true]) test(`${action} second-target I/O failure retains the applied prefix and renders a ${json ? "standalone JSON" : "human"} partial receipt`, async () => {
  const f = fixture(), originalDemote = MemoryStore.prototype.demote, originalForget = MemoryStore.prototype.forget, calls: string[] = [];
  const before = f.use(store => f.ids.map(id => store.get(id, f.project))), printed: string[] = []; let question = "", caught: unknown;
  try {
    if (action === "demote") MemoryStore.prototype.demote = function (...args: Parameters<MemoryStore["demote"]>) { calls.push(args[0]); if (calls.length === 2) throw Error("private raw filesystem failure"); return originalDemote.apply(this, args); };
    else MemoryStore.prototype.forget = function (...args: Parameters<MemoryStore["forget"]>) { calls.push(args[0]); if (calls.length === 2) throw Error("private raw filesystem failure"); return originalForget.apply(this, args); };
    try { await f.cli(["decay", ...f.ids, "--apply", ...(action === "forget" ? ["--forget"] : []), ...(json ? ["--json"] : [])], { write: line => printed.push(line), prompt: text => { question = text; return "yes"; } }); }
    catch (error) { caught = error; }
  } finally { MemoryStore.prototype.demote = originalDemote; MemoryStore.prototype.forget = originalForget; }
  expect(caught).toBeInstanceOf(DecayApplyError); const error = caught as DecayApplyError;
  expect(calls).toEqual(f.ids.slice(0, 2)); expect(error.report).toMatchObject({ action, applied: [f.ids[0]], failed: f.ids[1], remaining: [f.ids[2]] });
  expect(printed.join("\n")).toContain(f.ids[0]!); const rendered = formatCliError(error); expect(rendered).not.toContain("private raw filesystem failure");
  if (json) expect(JSON.parse(rendered)).toEqual({ ok: false, ...error.report, failedMayHaveChanged: true });
  else { expect(rendered).toContain(`applied: ${f.ids[0]}`); expect(rendered).toContain(`failed: ${f.ids[1]}`); expect(rendered).toContain(`remaining: ${f.ids[2]}`); expect(rendered).toContain("failed target may have changed"); }
  f.use(store => {
    const prefix = store.get(f.ids[0]!, f.project);
    if (action === "forget") { expect(prefix).toBeUndefined(); expect(question).toContain("hidden claude-mem-imported copies"); expect(error.report.expiresAt).toBeUndefined(); }
    else { expect(prefix?.tier).toBe("short"); expect(prefix?.expiresAt).toBe(error.report.expiresAt); expect(question).toContain(error.report.expiresAt!); }
    expect(store.get(f.ids[1]!, f.project)).toEqual(before[1]); expect(store.get(f.ids[2]!, f.project)).toEqual(before[2]);
  });
});
test("decay days accept only positive decimal syntax before any confirmation or authoritative writes", async () => {
  const f = fixture(), before = f.bytes(); let prompts = 0;
  for (const days of ["1e2", "0x5a", " 90", "+90", "0"]) await expect(f.cli(["decay", "--days", days, "--apply"], { write: () => {}, prompt: () => { prompts++; return "yes"; } })).rejects.toThrow("positive decimal integer");
  expect(prompts).toBe(0); expect(f.bytes()).toEqual(before);
  const preview = JSON.parse(await f.cli(["decay", "--days", "90", "--json"])); expect(preview.days).toBe(90); expect(preview.entries).toHaveLength(3); expect(f.bytes()).toEqual(before);
});
test("successful demotion receipt and confirmation pin the exact expiry written to the note", async () => {
  const f = fixture(); let question = ""; const printed: string[] = [];
  const result = JSON.parse(await f.cli(["decay", f.ids[0]!, "--apply", "--json"], { write: text => printed.push(text), prompt: text => { question = text; return "yes"; } }));
  expect(result).toMatchObject({ action: "demote", ids: [f.ids[0]] }); expect(typeof result.expiresAt).toBe("string"); expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now()); expect(question).toContain(result.expiresAt); expect(printed.join("\n")).toContain("revision");
  f.use(store => { expect(store.get(f.ids[0]!, f.project)).toMatchObject({ tier: "short", expiresAt: result.expiresAt }); expect(store.get(f.ids[1]!, f.project)?.tier).toBe("long"); expect(store.get(f.ids[2]!, f.project)?.tier).toBe("long"); });
});
