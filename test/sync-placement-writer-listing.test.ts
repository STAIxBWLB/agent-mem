import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { activationOwnRoot, placementActivationFixture } from "./fakes/sync-placement-activation.ts";
import { activateSyncPlacement } from "../src/memory/sync-placement-activation.ts";
import { releasePlacementStorageCaches } from "../src/memory/sync-placement-journal-storage.ts";
import { realPath } from "../src/memory/platform.ts";
import { confirmPlacementCheckpoint, previewPlacementCheckpoint } from "../src/memory/sync-placement-checkpoint-person.ts";
import { listPlacementWriters, placementWriterCommand, PLACEMENT_WRITERS_NOTE, shellQuote } from "../src/memory/sync-placement-writer-listing.ts";
import { runCli } from "../src/cli.ts";
import { completionScript } from "../src/completion.ts";
import { commandHelp } from "../src/commands-table.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); releasePlacementStorageCaches(); });
function writer(dir: string, version: string): string {
  mkdirSync(join(dir, "src"), { recursive: true, mode: 0o755 }); mkdirSync(join(dir, "bin"), { mode: 0o755 });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@staix/agent-mem", version }), { mode: 0o644 });
  writeFileSync(join(dir, "src", "index.ts"), "// isolated writer\n", { mode: 0o644 });
  writeFileSync(join(dir, "src", "cli.ts"), "// isolated writer\n", { mode: 0o644 });
  writeFileSync(join(dir, "bin", "amem.js"), "// isolated writer\n", { mode: 0o755 });
  return realPath(dir);
}
function receipt(home: string, entry: string): void {
  const image = (text: string) => ({ mode: 0o600, bytes: Buffer.from(text).toString("base64") });
  const doc = JSON.stringify({ mcpServers: { amem: { command: "/fixture/bin/bun", args: ["--smol", entry, "mcp"] } } });
  mkdirSync(join(home, "setup"), { mode: 0o700 });
  writeFileSync(join(home, "setup", "qwen.json"), JSON.stringify({ version: 2, target: "qwen", intent: "a".repeat(64), phase: "applied",
    changes: [{ key: "qwen:0", path: "/native/not-opened/qwen/0", before: image("{}"), after: image(doc), start: image("{}") }] }) + "\n", { mode: 0o600 });
}
/** Inventory {own, kept, removed}; removed is deleted; a running install outside the inventory; one qwen setup receipt. */
async function scene() {
  const f = await placementActivationFixture(); cleanup.push(f.close);
  await activateSyncPlacement(f.options("apply"));
  writeFileSync(join(f.base, "formats.json"), JSON.stringify([{ surface: "home", minReader: "0.30.0", since: "2026-11-19" }]) + "\n", { mode: 0o600 });
  const kept = writer(join(f.root, "kept writer"), "0.39.0"), removed = writer(join(f.root, "removed writer"), "0.38.0");
  const three = { writerRoots: [activationOwnRoot, kept, removed], ownRoot: activationOwnRoot };
  expect(await confirmPlacementCheckpoint(f.base, await previewPlacementCheckpoint(f.base, three), three)).toMatchObject({ window: 1, renewed: true });
  rmSync(removed, { recursive: true });
  const running = writer(join(f.root, "running writer"), "0.40.0"), hosted = writer(join(f.root, "host's bundle"), "0.40.0");
  receipt(f.base, join(hosted, "bin", "amem.js"));
  return { f, own: realPath(activationOwnRoot), kept, removed, running, hosted };
}

test("#639 AC1: the listing reports each source with its state, and its command saves a preview that confirms", async () => {
  const { f, own, kept, removed, running, hosted } = await scene();
  const listing = listPlacementWriters(f.base, running);
  expect(listing.schema).toBe("amem.placement-writers/v1");
  expect(listing.inventory).toEqual([own, kept, removed].sort().map(root => root === removed ? { root, version: null, state: "missing" }
    : { root, version: root === kept ? "0.39.0" : expect.any(String), state: "present" }));
  expect(listing.running).toEqual({ root: running, version: "0.40.0", inInventory: false });
  expect(listing.receipts).toEqual([{ target: "qwen", root: hosted, state: "present" }]);
  const roots = [own, kept, running, hosted].sort();
  expect(listing.suggestedRoots).toEqual(roots);
  expect(listing.command).toBe(placementWriterCommand(roots));
  expect(listing.command).toContain(`--writer-root ${shellQuote(hosted)}`);
  expect(listing.command).toContain("'\\''");
  expect(listing.command).not.toContain(removed);
  expect(listing.note).toBe(PLACEMENT_WRITERS_NOTE);
  const declared = { writerRoots: listing.suggestedRoots, ownRoot: running };
  const preview = await previewPlacementCheckpoint(f.base, declared);
  expect(await confirmPlacementCheckpoint(f.base, preview, declared)).toMatchObject({ window: 2, renewed: true });
}, 300_000);

test("#639 AC1: a receipt whose install was removed is listed as missing instead of refusing", async () => {
  const { f, hosted, running } = await scene();
  rmSync(hosted, { recursive: true });
  const listing = listPlacementWriters(f.base, running);
  expect(listing.receipts).toEqual([{ target: "qwen", root: hosted, state: "missing" }]);
  expect(listing.suggestedRoots).not.toContain(hosted);
}, 300_000);

test("#639 AC3/AC4: CLI JSON is versioned, marked sessions pass the policy screen, misuse is a usage error, help and completion name it", async () => {
  const { f } = await scene();
  const prior = process.env.AMEM_HOME; process.env.AMEM_HOME = f.base;
  try {
    const plain = JSON.parse(await runCli(["migrate", "--sync-placement", "--writers", "--json"], { cwd: f.root, env: {}, stdinTTY: false, processTable: () => "" }));
    expect(plain.schema).toBe("amem.placement-writers/v1");
    expect(Object.keys(plain)).toEqual(["schema", "inventory", "running", "receipts", "runningHosts", "suggestedRoots", "command", "note"]);
    const marked = await runCli(["migrate", "--sync-placement", "--writers", "--json"], { cwd: f.root, env: { CODEX_THREAD_ID: "t" }, stdinTTY: false, processTable: () => "" });
    expect(JSON.parse(marked)).toEqual(plain);
    const text = await runCli(["migrate", "--sync-placement", "--writers"], { cwd: f.root, env: { CODEX_THREAD_ID: "t" }, stdinTTY: false, processTable: () => "" });
    expect(text).toContain("roots to declare:"); expect(text).toContain(`next: ${plain.command}`);
    for (const argv of [["migrate", "--writers"], ["migrate", "--sync-placement", "--writers", "--checkpoint"], ["migrate", "--sync-placement", "--writers", "--apply"]])
      await expect(runCli(argv, { cwd: f.root, env: {}, stdinTTY: false })).rejects.toThrow("usage: amem migrate --sync-placement --writers [--json]");
  } finally { if (prior === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = prior; }
  const help = commandHelp(["migrate"]);
  expect(help).toContain("--writers");
  for (const line of help.split("\n")) expect(line.length).toBeLessThanOrEqual(80);
  for (const shell of ["zsh", "bash", "fish"] as const) expect(completionScript(shell)).toContain("--writers");
}, 300_000);

test("#639 AC3: a marked session's output is withheld when the configured policy refuses it", async () => {
  const { f } = await scene();
  writeFileSync(join(f.base, "amem.config.json"), JSON.stringify({ denyPaths: [f.root] }) + "\n", { mode: 0o600 });
  const prior = process.env.AMEM_HOME; process.env.AMEM_HOME = f.base;
  try {
    const json = await runCli(["migrate", "--sync-placement", "--writers", "--json"], { cwd: f.root, env: { CODEX_THREAD_ID: "t" }, stdinTTY: false });
    expect(JSON.parse(json)).toEqual({ ok: true, completed: true, receiptWithheld: true });
    expect(json).not.toContain(f.root);
    const text = await runCli(["migrate", "--sync-placement", "--writers"], { cwd: f.root, env: { CODEX_THREAD_ID: "t" }, stdinTTY: false });
    expect(text).toBe("Operation completed; receipt withheld by policy. Run amem status to inspect state.");
    // An unmarked person read stays unscreened.
    expect(await runCli(["migrate", "--sync-placement", "--writers"], { cwd: f.root, env: {}, stdinTTY: false })).toContain("roots to declare:");
  } finally { if (prior === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = prior; }
}, 300_000);

test("#639 AC2: the doctor writer finding and the checkpoint candidate refusal name the listing first", async () => {
  const { writerFinding } = await import("../src/memory/doctor-text.ts");
  const { PlacementCheckpointError } = await import("../src/memory/sync-placement-checkpoint-person.ts");
  const reason = "Sync placement writer proof is missing (declared writer category); restore the inventoried install, or renew it through the checkpoint while sessions keep running: save the preview with (umask 077; set -C; amem migrate --sync-placement --checkpoint --writer-root <install root> --json > checkpoint-plan.json), repeating --writer-root for every install root, then run amem migrate --sync-placement --checkpoint --confirm --plan checkpoint-plan.json with the same --writer-root list.";
  expect(writerFinding({ cause: "missing", category: "declared writer", reason }).next).toEqual(["amem migrate --sync-placement --writers", "amem migrate --sync-placement --checkpoint"]);
  expect(new PlacementCheckpointError("candidate").message).toStartWith("A checkpoint carries one writer renewal: list the inventory and the roots to declare with amem migrate --sync-placement --writers, then pass the complete inventory");
});

test("#639 with #636: a stale agy receipt keeps its single next step; --writers is not added before it", async () => {
  const { writerFinding } = await import("../src/memory/doctor-text.ts");
  const reason = "Sync placement writer proof is missing (setup receipt category); list the agy workspaces with amem setup agy --list, or renew through amem migrate --sync-placement --checkpoint --confirm --plan checkpoint-plan.json.";
  expect(writerFinding({ cause: "missing", category: "setup receipt", reason }).next).toEqual(["amem setup agy --refresh", "amem setup agy --list"]);
});

test("#660 AC2: --writers finds a host bundle from the process table and behind ahub/vmem on PATH, and suggests it", async () => {
  const { f, running } = await scene();
  const live = join(f.root, "live-host"), onPath = join(f.root, "path host"), bin = join(f.root, "bin");
  const liveRoot = writer(join(live, "node_modules", "@staix", "agent-mem"), "0.41.0"), pathRoot = writer(join(onPath, "node_modules", "@staix", "agent-mem"), "0.41.0");
  mkdirSync(join(live, "dist"), { recursive: true }); writeFileSync(join(live, "dist", "ahub.js"), "// host\n");
  mkdirSync(join(onPath, "dist"), { recursive: true }); writeFileSync(join(onPath, "dist", "vmem.js"), "// host\n");
  mkdirSync(bin); symlinkSync(join(onPath, "dist", "vmem.js"), join(bin, "vmem"));
  const listing = listPlacementWriters(f.base, running, { table: () => `4242 /usr/local/bin/bun ${join(live, "dist", "ahub.js")} daemon\n`, path: `relative:${bin}` });
  expect(listing.runningHosts).toEqual([
    { pid: 4242, root: liveRoot, version: "0.41.0", host: join(live, "dist", "ahub.js") },
    { root: pathRoot, version: "0.41.0", host: realPath(join(onPath, "dist", "vmem.js")) },
  ]);
  expect(listing.suggestedRoots).toContain(liveRoot); expect(listing.suggestedRoots).toContain(pathRoot);
  expect(listing.command).toBe(placementWriterCommand(listing.suggestedRoots));
  // A host bundle without a readable version is listed but never suggested.
  writeFileSync(join(liveRoot, "package.json"), "{}");
  expect(listPlacementWriters(f.base, running, { table: () => `4242 /usr/local/bin/bun ${join(live, "dist", "ahub.js")}\n` }).suggestedRoots).not.toContain(liveRoot);
}, 300_000);

test("#660 AC3: --discovered-writers --out saves a private plan, and --confirm --plan without --writer-root re-measures its roots", async () => {
  const { f, own, kept, hosted } = await scene();
  const prior = process.env.AMEM_HOME; process.env.AMEM_HOME = f.base;
  const run = (...argv: string[]) => runCli(["migrate", "--sync-placement", "--checkpoint", ...argv], { cwd: f.root, env: {}, stdinTTY: false, processTable: () => "" });
  try {
    const plan = join(f.root, "checkpoint plan.json");
    const text = await run("--discovered-writers", "--out", plan);
    expect(statSync(plan).mode & 0o777).toBe(0o600);
    for (const root of [own, kept, hosted]) expect(text).toContain(`  ${root}`);           // every measured root is printed before confirming
    expect(text).toContain(`next: amem migrate --sync-placement --checkpoint --confirm --plan '${plan}'`);
    const saved = JSON.parse(readFileSync(plan, "utf8"));
    expect(saved.plan.writerRevision.roots.map((root: { root: string }) => root.root).sort()).toEqual([own, kept, hosted].sort());
    await expect(run("--discovered-writers", "--out", plan)).rejects.toThrow("the --out path already exists");
    const link = join(f.root, "link.json"); symlinkSync(join(f.root, "elsewhere.json"), link);
    await expect(run("--discovered-writers", "--out", link)).rejects.toThrow("choose a new --out file");
    expect(existsSync(join(f.root, "elsewhere.json"))).toBe(false); expect(lstatSync(link).isSymbolicLink()).toBe(true);
    for (const argv of [["--discovered-writers", "--writer-root", own], ["--confirm", "--plan", plan, "--out", join(f.root, "x.json")], ["--resume", "--discovered-writers"]])
      await expect(run(...argv)).rejects.toThrow("--out <file> and --discovered-writers apply only to a checkpoint preview");
    // A root changed on disk since the preview refuses; the plan's own roots are measured, never trusted.
    writeFileSync(join(kept, "src", "index.ts"), "// changed after the preview\n");
    await expect(run("--confirm", "--plan", plan)).rejects.toThrow();
    writeFileSync(join(kept, "src", "index.ts"), "// isolated writer\n");
    const fresh = join(f.root, "fresh.json");
    await run("--discovered-writers", "--out", fresh);
    expect(JSON.parse(await run("--confirm", "--plan", fresh, "--json"))).toMatchObject({ window: 2, renewed: true });
    // A marked session whose plan the policy withholds (a root name, absent from argv) writes no file.
    writeFileSync(join(f.base, "amem.config.json"), JSON.stringify({ piiPatterns: ["kept writer"] }));
    const denied = join(f.root, "withheld.json");
    const marked = runCli(["migrate", "--sync-placement", "--checkpoint", "--discovered-writers", "--out", denied], { cwd: f.root, env: { CLAUDECODE: "1" }, stdinTTY: false, processTable: () => "" });
    await expect(marked).rejects.toThrow("no partial result is shown");
    expect(existsSync(denied)).toBe(false);
  } finally { if (prior === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = prior; }
}, 300_000);

test("#660 AC1: formats raise counts no removed install, and still refuses a present root with a corrupt package.json", async () => {
  const { f, kept, removed, hosted } = await scene();
  const prior = process.env.AMEM_HOME; process.env.AMEM_HOME = f.base;
  const raise = async () => JSON.parse(await runCli(["formats", "raise", "home", "0.36.0", "--json"], { cwd: f.root, env: {}, stdinTTY: false, processTable: () => "" }));
  try {
    const ready = await raise();
    expect(ready.absent.map((writer: { root: string }) => writer.root)).toEqual([removed]);
    expect(ready.below).toEqual([]); expect(ready.ready).toBe(true); expect(ready.refusal).toBeNull();
    // A surviving host that still names a path under the removed root keeps it counted, and so does an unreadable process table.
    const live = JSON.parse(await runCli(["formats", "raise", "home", "0.36.0", "--json"], { cwd: f.root, env: {}, stdinTTY: false, processTable: () => `  4343 node ${removed}/dist/host.js` }));
    expect(live.absent).toEqual([]); expect(live.below.map((writer: { root: string }) => writer.root)).toEqual([removed]); expect(live.ready).toBe(false);
    const blind = JSON.parse(await runCli(["formats", "raise", "home", "0.36.0", "--json"], { cwd: f.root, env: {}, stdinTTY: false, processTable: () => { throw Error("ps unavailable"); } }));
    expect(blind.absent).toEqual([]); expect(blind.ready).toBe(false);
    writeFileSync(join(kept, "package.json"), "not json");
    const refused = await raise();
    expect(refused.below.map((writer: { root: string; version: unknown }) => [writer.root, writer.version])).toEqual([[kept, null]]);
    expect(refused.refusal).toContain("unknown version");
    writeFileSync(join(kept, "package.json"), JSON.stringify({ name: "@staix/agent-mem", version: "0.39.0" }));
    expect(JSON.parse(await runCli(["formats", "raise", "home", "0.36.0", "--confirm", "--json"], { cwd: f.root, env: {}, stdinTTY: false, processTable: () => "" })).appended).toMatchObject({ surface: "home", minReader: "0.36.0" });
    // A host entry outside the bundle: <host>/dist/ahub.js whose inventoried <host>/node_modules/@staix/agent-mem was removed.
    const host = join(f.root, "gone-host"), bundle = writer(join(host, "node_modules", "@staix", "agent-mem"), "0.38.0");
    const roots = { writerRoots: [activationOwnRoot, kept, hosted, bundle], ownRoot: activationOwnRoot };
    expect(await confirmPlacementCheckpoint(f.base, await previewPlacementCheckpoint(f.base, roots), roots)).toMatchObject({ window: 2, renewed: true });
    rmSync(bundle, { recursive: true }); mkdirSync(join(host, "dist"), { recursive: true });
    const hostRun = (table: string) => runCli(["formats", "raise", "home", "0.37.0", "--json"], { cwd: f.root, env: {}, stdinTTY: false, processTable: () => table }).then(JSON.parse);
    const held = await hostRun(`  4444 node ${join(host, "dist", "ahub.js")}`);
    expect(held.below.map((w: { root: string }) => w.root)).toEqual([bundle]); expect(held.absent).toEqual([]); expect(held.ready).toBe(false);
    const freed = await hostRun(`  4445 node ${join(f.root, "other-host", "dist", "ahub.js")}`);
    expect(freed.absent.map((w: { root: string }) => w.root)).toEqual([bundle]); expect(freed.below).toEqual([]); expect(freed.ready).toBe(true);
  } finally { if (prior === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = prior; }
}, 300_000);
