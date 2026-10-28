import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatCliError, runCli, type CliContext } from "../src/cli.ts";
import { DecayApplyError } from "../src/memory/decay-review.ts";
import { realPath } from "../src/memory/platform.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { CONFIG_FILE } from "../src/memory/config.ts";
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
  return { root, base, ids, project, use, bytes, cli };
}
async function failSecondMarkedTarget(f: ReturnType<typeof fixture>, action: "demote" | "forget", args: string[], extra: Partial<CliContext> = {}): Promise<string> {
  const originalDemote = MemoryStore.prototype.demote, originalForget = MemoryStore.prototype.forget; let calls = 0;
  if (action === "demote") MemoryStore.prototype.demote = function (...params: Parameters<MemoryStore["demote"]>) { if (++calls === 2) throw Error("private raw filesystem failure"); return originalDemote.apply(this, params); };
  else MemoryStore.prototype.forget = function (...params: Parameters<MemoryStore["forget"]>) { if (++calls === 2) throw Error("private raw filesystem failure"); return originalForget.apply(this, params); };
  try { return await f.cli(args, { env: { CODEX_THREAD_ID: "agent", HOME: f.root, AMEM_HOME: join(f.root, "memory") }, stdinTTY: false, stdoutTTY: false, ...extra }); }
  finally { MemoryStore.prototype.demote = originalDemote; MemoryStore.prototype.forget = originalForget; }
}
function expectAppliedPrefix(f: ReturnType<typeof fixture>, action: "demote" | "forget"): void {
  f.use(store => {
    const [first, second, third] = f.ids;
    if (action === "forget") { expect(store.get(first!, f.project)).toBeUndefined(); expect(store.get(second!, f.project)).toBeDefined(); }
    else { expect(store.get(first!, f.project)?.tier).toBe("short"); expect(store.get(second!, f.project)?.tier).toBe("long"); }
    expect(store.get(third!, f.project)?.tier).toBe("long");
  });
}
async function renderFailure(work: Promise<string>): Promise<string> {
  try { return await work; } catch (error) { return formatCliError(error); }
}
for (const action of ["demote", "forget"] as const) for (const json of [false, true]) test(`${action} second-target I/O failure retains the applied prefix and renders a ${json ? "standalone JSON" : "human"} partial receipt`, async () => {
  const f = fixture(), originalDemote = MemoryStore.prototype.demote, originalForget = MemoryStore.prototype.forget, calls: string[] = [];
  const before = f.use(store => f.ids.map(id => store.get(id, f.project))), printed: string[] = []; let prompts = 0, caught: unknown;
  try {
    if (action === "demote") MemoryStore.prototype.demote = function (...args: Parameters<MemoryStore["demote"]>) { calls.push(args[0]); if (calls.length === 2) throw Error("private raw filesystem failure"); return originalDemote.apply(this, args); };
    else MemoryStore.prototype.forget = function (...args: Parameters<MemoryStore["forget"]>) { calls.push(args[0]); if (calls.length === 2) throw Error("private raw filesystem failure"); return originalForget.apply(this, args); };
    try { await f.cli(["decay", ...f.ids, "--apply", "--confirm", ...(action === "forget" ? ["--forget"] : []), ...(json ? ["--json"] : [])], { write: line => printed.push(line), prompt: () => { prompts++; throw Error("decay does not prompt"); } }); }
    catch (error) { caught = error; }
  } finally { MemoryStore.prototype.demote = originalDemote; MemoryStore.prototype.forget = originalForget; }
  expect(caught).toBeInstanceOf(DecayApplyError); const error = caught as DecayApplyError;
  expect(calls).toEqual(f.ids.slice(0, 2)); expect(error.report).toMatchObject({ action, applied: [f.ids[0]], failed: f.ids[1], remaining: [f.ids[2]] });
  expect(prompts).toBe(0); const rendered = formatCliError(error); expect(rendered).toContain(f.ids[0]!); expect(rendered).not.toContain("private raw filesystem failure");
  if (json) expect(JSON.parse(rendered)).toEqual({ ok: false, ...error.report, failedMayHaveChanged: true });
  else { expect(rendered).toContain(`applied: ${f.ids[0]}`); expect(rendered).toContain(`failed: ${f.ids[1]}`); expect(rendered).toContain(`remaining: ${f.ids[2]}`); expect(rendered).toContain("failed target may have changed"); }
  f.use(store => {
    const prefix = store.get(f.ids[0]!, f.project);
    if (action === "forget") { expect(prefix).toBeUndefined(); expect(error.report.expiresAt).toBeUndefined(); }
    else { expect(prefix?.tier).toBe("short"); expect(prefix?.expiresAt).toBe(error.report.expiresAt); }
    expect(store.get(f.ids[1]!, f.project)).toEqual(before[1]); expect(store.get(f.ids[2]!, f.project)).toEqual(before[2]);
  });
});
test("decay days accept only positive decimal syntax before a plan or authoritative writes", async () => {
  const f = fixture(), before = f.bytes(); let prompts = 0;
  for (const days of ["1e2", "0x5a", " 90", "+90", "0"]) await expect(f.cli(["decay", "--days", days, "--apply"], { write: () => {}, prompt: () => { prompts++; return "yes"; } })).rejects.toThrow("positive decimal integer");
  expect(prompts).toBe(0); expect(f.bytes()).toEqual(before);
  const preview = JSON.parse(await f.cli(["decay", "--days", "90", "--json"])); expect(preview.days).toBe(90); expect(preview.entries).toHaveLength(3); expect(f.bytes()).toEqual(before);
});
test("confirmed demotion pins the exact expiry written to the note without prompting", async () => {
  const f = fixture(), preview = JSON.parse(await f.cli(["decay", f.ids[0]!, "--apply", "--json"])); let prompts = 0;
  expect(preview.entries.map((row: { target: { id: string } }) => row.target.id)).toEqual([f.ids[0]]);
  const result = JSON.parse(await f.cli(["decay", f.ids[0]!, "--apply", "--confirm", "--json"], { stdinTTY: false, stdoutTTY: false, prompt: () => { prompts++; throw Error("decay does not prompt"); } }));
  expect(result).toMatchObject({ action: "demote", ids: [f.ids[0]] }); expect(typeof result.expiresAt).toBe("string"); expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now()); expect(prompts).toBe(0);
  f.use(store => { expect(store.get(f.ids[0]!, f.project)).toMatchObject({ tier: "short", expiresAt: result.expiresAt }); expect(store.get(f.ids[1]!, f.project)?.tier).toBe("long"); expect(store.get(f.ids[2]!, f.project)?.tier).toBe("long"); });
});

for (const action of ["demote", "forget"] as const) {
  test(`marked ${action} partial failure retains its applied prefix and a policy-approved report`, async () => {
    const f = fixture(), args = ["decay", ...f.ids, "--apply", "--confirm", ...(action === "forget" ? ["--forget"] : []), "--json"];
    const error = await failSecondMarkedTarget(f, action, args).catch(failure => failure);
    expect(error).toBeInstanceOf(DecayApplyError);
    const output = JSON.parse(formatCliError(error));
    expect(output).toMatchObject({ ok: false, action, applied: [f.ids[0]], failed: f.ids[1], remaining: [f.ids[2]], failedMayHaveChanged: true });
    if (action === "demote") expect(typeof output.expiresAt).toBe("string");
    expect(JSON.stringify(output)).not.toContain("private raw filesystem failure"); expectAppliedPrefix(f, action);
  });

  test(`marked ${action} partial failure with a denied report returns only a generic counted outcome`, async () => {
    const f = fixture(), args = ["decay", ...f.ids, "--apply", "--confirm", ...(action === "forget" ? ["--forget"] : []), "--json"];
    writeFileSync(join(f.root, "memory", CONFIG_FILE), JSON.stringify({ piiPatterns: ["applied"] }));
    const output = JSON.parse(await renderFailure(failSecondMarkedTarget(f, action, args)));
    expect(output).toEqual({ ok: false, partial: true, appliedCount: 1, failedMayHaveChanged: true, receiptWithheld: true });
    expect(JSON.stringify(output)).not.toContain(f.ids[0]!); expect(JSON.stringify(output)).not.toContain(f.ids[1]!); expect(JSON.stringify(output)).not.toContain(f.ids[2]!);
    expect(JSON.stringify(output)).not.toContain("private raw filesystem failure"); expectAppliedPrefix(f, action);
  });

  test(`marked ${action} partial failure with a denied report has a fixed human receipt`, async () => {
    const f = fixture(), args = ["decay", ...f.ids, "--apply", "--confirm", ...(action === "forget" ? ["--forget"] : [])];
    writeFileSync(join(f.root, "memory", CONFIG_FILE), JSON.stringify({ piiPatterns: ["applied"] }));
    const output = await renderFailure(failSecondMarkedTarget(f, action, args));
    expect(output).toBe("Operation partially applied; receipt withheld by policy. Inspect state before retrying.");
    for (const id of f.ids) expect(output).not.toContain(id);
    expect(output).not.toContain("private raw filesystem failure"); expectAppliedPrefix(f, action);
  });
}
