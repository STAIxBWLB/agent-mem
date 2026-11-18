import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { runCli } from "../src/cli.ts";
import { openShardStore } from "../src/memory/store.ts";
import { shardDir, shardKeyHash } from "../src/memory/shard.ts";
import { WorkListStore } from "../src/memory/work-lists.ts";
import { syncMemory } from "../src/memory/sync.ts";
import { memoryGitSync } from "../src/memory/platform.ts";
import { bareRemote, closeInventoryFixtures, inventoryFixture } from "./fakes/sync-placement-inventory.ts";

afterEach(closeInventoryFixtures);
const privateVisibility = async () => "private" as const;
async function sync(home: string, opts: Parameters<typeof syncMemory>[1]) {
  const user = openShardStore({ memoryDir: home, user: true, deferPromotions: true });
  try { return await syncMemory(user, opts); } finally { user.close(); }
}

test("remote-only realm is explicitly previewed and admitted without changing existing work", async () => {
  const shared = "example.test/adoption/shared", target = "example.test/adoption/target";
  const a = await inventoryFixture(2, [shared, target], true), b = await inventoryFixture(1, [shared], true), remote = bareRemote();
  expect((await sync(a.home, a.opts(remote))).ok).toBe(true);
  const targetRef = `refs/heads/amem/p/${shardKeyHash(target)}`, head = () => memoryGitSync(["--git-dir", remote, "rev-parse", targetRef], { encoding: "utf8" }).stdout.trim();
  const beforeHead = head(); expect(beforeHead).toMatch(/^[a-f0-9]{40}$/); expect(existsSync(shardDir(b.home, target))).toBe(false);
  expect((await sync(b.home, b.opts(remote))).ok).toBe(true);
  expect(head()).toBe(beforeHead); expect(existsSync(shardDir(b.home, target))).toBe(false);
  const work = new WorkListStore({ base: b.home, project: target, policy: () => true });
  try { await work.write("existing", { task: "preserved local work" }); } finally { work.close(); }
  const project = shardDir(b.home, target), before = readFileSync(join(project, "project.json")), prior = process.env.AMEM_HOME; process.env.AMEM_HOME = b.home;
  try {
    const invoke = (args: string[]) => runCli(args, { cwd: b.root, env: {}, visibility: privateVisibility });
    await expect(invoke(["migrate", "--sync-placement", "--admit", target, "--from-remote", "--dry-run", "--remote", remote])).rejects.toThrow();
    await expect(invoke(["migrate", "--sync-placement", "--from-remote", "--dry-run"])).rejects.toThrow();
    const listing = JSON.parse(await invoke(["migrate", "--sync-placement", "--list-remote", "--json"]));
    expect(listing.realms).toContainEqual({ scope: "project", keyHash: shardKeyHash(target) });
    const dry = await invoke(["migrate", "--sync-placement", "--admit", target, "--from-remote", "--dry-run", "--json"]);
    const preview = JSON.parse(dry); expect(preview.state).toBe("preview"); expect(preview.omitted).toBe(0); expect(preview.remoteHead).toMatch(/^[a-f0-9]{40}$/);
    expect(dry).not.toContain(target); expect(dry).not.toContain(remote); expect(existsSync(join(project, "generation.json"))).toBe(false);
    const applied = JSON.parse(await invoke(["migrate", "--sync-placement", "--admit", target, "--from-remote", "--apply", "--json"]));
    expect(applied).toMatchObject({ state: "admitted", omitted: 0, nextStep: "amem sync" });
    expect(readFileSync(join(project, "project.json"))).toEqual(before);
    const workAgain = new WorkListStore({ base: b.home, project: target, policy: () => true });
    try { expect((await workAgain.read())[0]?.items[0]?.task).toBe("preserved local work"); } finally { workAgain.close(); }
    const targetStore = openShardStore({ memoryDir: b.home, project: target, deferPromotions: true });
    try { expect(targetStore.list({ project: target }).map(row => row.text)).toContain(`inventory note for ${target}`); } finally { targetStore.close(); }
    expect(readdirSync(b.home).filter(name => name.startsWith("placement-remote-adoption-")).length).toBe(0);
    expect((await sync(b.home, b.opts(remote))).ok).toBe(true); expect((await sync(a.home, a.opts(remote))).ok).toBe(true);
  } finally { if (prior === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = prior; }
}, 240_000);

test("an older admission during staging is never duplicated and later sync imports remote rows", async () => {
  const { remoteRealmAdmission } = await import("../src/memory/sync-placement-remote-admission.ts");
  const oldRoot = mkdtempSync(join(tmpdir(), "amem-029-remote-race-"));
  const archive = Bun.spawnSync(["git", "archive", "57a4ace57bdf5c4fc12996146c76843de4ee21cc"], { stdout: "pipe", stderr: "pipe" });
  expect(archive.exitCode, archive.stderr.toString()).toBe(0);
  const extract = Bun.spawnSync(["tar", "-x", "-C", oldRoot], { stdin: archive.stdout, stdout: "ignore", stderr: "pipe" });
  expect(extract.exitCode, extract.stderr.toString()).toBe(0);
  const oldAdmission = await import(pathToFileURL(join(oldRoot, "src/memory/sync-placement-realm-admission.ts")).href);
  const shared = "example.test/adoption-race/shared", target = "example.test/adoption-race/target";
  try {
    const a = await inventoryFixture(2, [shared, target], true), remote = bareRemote(); expect((await sync(a.home, a.opts(remote))).ok).toBe(true);
    for (const stage of ["after-companion", "after-stage", "after-install", "after-intent", "after-metadata", "after-proof", "after-append"] as const) {
      const b = await inventoryFixture(1, [shared], true, [oldRoot]); expect((await sync(b.home, b.opts(remote))).ok).toBe(true);
      await expect(remoteRealmAdmission(b.home, target, { mode: "apply", visibility: privateVisibility, checkpoint: at => {
        if (at === stage) throw Error("isolated crash seam");
      } })).rejects.toThrow();
      const oldMode = ["after-intent", "after-metadata", "after-proof", "after-append"].includes(stage) ? "resume" : "apply";
      expect(await oldAdmission.applyRealmAdmission(b.home, target, { mode: oldMode })).toMatchObject({ state: "admitted" });
      const extension = join(b.home, "placement-realm-extensions.jsonl"), before = readFileSync(extension);
      const resumed = await remoteRealmAdmission(b.home, target, { mode: "resume", visibility: privateVisibility });
      expect(resumed).toMatchObject({ state: "already-admitted", nextStep: "amem sync" }); expect(readFileSync(extension)).toEqual(before);
      expect(readdirSync(b.home).filter(name => name.includes("placement-remote-adoption-")).length).toBe(0);
      expect((await sync(b.home, b.opts(remote))).ok).toBe(true);
      const targetStore = openShardStore({ memoryDir: b.home, project: target, deferPromotions: true });
      try { expect(targetStore.list({ project: target }).map(row => row.text)).toContain(`inventory note for ${target}`); } finally { targetStore.close(); }
    }
  } finally { rmSync(oldRoot, { recursive: true, force: true }); }
}, 240_000);

test("remote admission resumes or abandons each durable staging boundary", async () => {
  const { remoteRealmAdmission } = await import("../src/memory/sync-placement-remote-admission.ts");
  const { readPlacementRuntimeMarkers } = await import("../src/memory/sync-placement-guard.ts");
  const { readActivePlacementBinding } = await import("../src/memory/sync-placement-active.ts");
  const { readEffectiveRealmInventory } = await import("../src/memory/sync-placement-realm-effective.ts");
  const { createHash } = await import("node:crypto");
  const shared = "example.test/adoption-crash/shared", target = "example.test/adoption-crash/target";
  const a = await inventoryFixture(2, [shared, target], true), remote = bareRemote();
  expect((await sync(a.home, a.opts(remote))).ok).toBe(true);
  for (const action of ["resume", "abandon"] as const) for (const stage of ["after-companion", "after-stage", "after-install", "after-intent", "after-metadata", "after-proof", "after-append", "after-admission"] as const) {
    const b = await inventoryFixture(1, [shared], true); expect((await sync(b.home, b.opts(remote))).ok).toBe(true);
    const work = new WorkListStore({ base: b.home, project: target, policy: () => true });
    try { await work.write("existing", { task: "keep across crash" }); } finally { work.close(); }
    await expect(remoteRealmAdmission(b.home, target, { mode: "apply", visibility: privateVisibility, checkpoint: at => {
      if (at === stage) throw Error("isolated crash seam");
    } })).rejects.toThrow();
    const result = await remoteRealmAdmission(b.home, target, { mode: action, ...(action === "abandon" ? { confirm: true } : {}), visibility: privateVisibility });
    const afterCommit = stage === "after-append" || stage === "after-admission", committed = action === "resume" || afterCommit;
    expect(result.state).toBe(committed ? (afterCommit ? "already-admitted" : "admitted") : "abandoned");
    const markers = readPlacementRuntimeMarkers(b.home), binding = readActivePlacementBinding(b.home, markers.profile, markers.shards)!;
    const realm = createHash("sha256").update(target).digest("hex");
    expect(readEffectiveRealmInventory(b.home, binding).realms.some(item => item.scope === "project" && item.keyHash === realm)).toBe(committed);
    expect(readdirSync(b.home).filter(name => name.startsWith("placement-remote-adoption-")).length).toBe(0);
    expect(readdirSync(b.home).filter(name => name.startsWith("placement-realm-intent-")).length).toBe(0);
    const restored = new WorkListStore({ base: b.home, project: target, policy: () => true });
    try { expect((await restored.read())[0]?.items[0]?.task).toBe("keep across crash"); } finally { restored.close(); }
    if (committed) {
      const reader = openShardStore({ memoryDir: b.home, project: target, deferPromotions: true });
      try { expect(reader.list({ project: target }).map(row => row.text)).toContain(`inventory note for ${target}`); } finally { reader.close(); }
    }
  }
}, 240_000);

test("a retained remote staging operation fences another remote admission", async () => {
  const { remoteRealmAdmission } = await import("../src/memory/sync-placement-remote-admission.ts");
  const shared = "example.test/adoption-serial/shared", first = "example.test/adoption-serial/first", second = "example.test/adoption-serial/second";
  const a = await inventoryFixture(3, [shared, first, second], true), b = await inventoryFixture(1, [shared], true), remote = bareRemote();
  expect((await sync(a.home, a.opts(remote))).ok).toBe(true); expect((await sync(b.home, b.opts(remote))).ok).toBe(true);
  await expect(remoteRealmAdmission(b.home, first, { mode: "apply", visibility: privateVisibility, checkpoint: stage => {
    if (stage === "after-companion") throw Error("fixture interruption");
  } })).rejects.toThrow();
  await expect(remoteRealmAdmission(b.home, second, { mode: "apply", visibility: privateVisibility })).rejects.toThrow("unavailable");
  expect(existsSync(join(shardDir(b.home, second), "generation.json"))).toBe(false);
  expect(await remoteRealmAdmission(b.home, first, { mode: "abandon", confirm: true, visibility: privateVisibility })).toMatchObject({ state: "abandoned" });
  expect(await remoteRealmAdmission(b.home, second, { mode: "apply", visibility: privateVisibility })).toMatchObject({ state: "admitted" });
}, 240_000);

test("a torn remote companion previews and confirms cleanup without changing other data", async () => {
  const { createHash } = await import("node:crypto");
  const { writeFileSync } = await import("node:fs");
  const { remoteRealmAdmission } = await import("../src/memory/sync-placement-remote-admission.ts");
  const shared = "example.test/adoption-pending/shared", target = "example.test/adoption-pending/target";
  const b = await inventoryFixture(1, [shared], true), hash = createHash("sha256").update(target).digest("hex");
  const file = join(b.home, `placement-remote-adoption-${hash}.json.${"a".repeat(64)}.pending`), bytes = Buffer.from("partial");
  writeFileSync(file, bytes, { mode: 0o600 });
  expect(await remoteRealmAdmission(b.home, target, { mode: "abandon" })).toMatchObject({ state: "retained", staged: 1 });
  expect(readFileSync(file)).toEqual(bytes);
  expect(await remoteRealmAdmission(b.home, target, { mode: "abandon", confirm: true })).toMatchObject({ state: "abandoned", staged: 1 });
  expect(existsSync(file)).toBe(false); expect(existsSync(join(shardDir(b.home, target), "generation.json"))).toBe(false);
}, 120_000);

test("the standard admission commands recognize a retained remote operation", async () => {
  const { remoteRealmAdmission } = await import("../src/memory/sync-placement-remote-admission.ts");
  const shared = "example.test/adoption-cli/shared", target = "example.test/adoption-cli/target";
  const a = await inventoryFixture(2, [shared, target], true), remote = bareRemote(); expect((await sync(a.home, a.opts(remote))).ok).toBe(true);
  for (const action of ["resume", "abandon"] as const) {
    const b = await inventoryFixture(1, [shared], true); expect((await sync(b.home, b.opts(remote))).ok).toBe(true);
    await expect(remoteRealmAdmission(b.home, target, { mode: "apply", visibility: privateVisibility, checkpoint: stage => {
      if (stage === "after-stage") throw Error("fixture interruption");
    } })).rejects.toThrow();
    const prior = process.env.AMEM_HOME; process.env.AMEM_HOME = b.home;
    try {
      const args = ["migrate", "--sync-placement", "--admit", target, `--${action}`, ...(action === "abandon" ? ["--confirm"] : []), "--json"];
      const output = await runCli(args, { cwd: b.root, env: {}, visibility: privateVisibility }), result = JSON.parse(output);
      expect(result.state).toBe(action === "resume" ? "admitted" : "abandoned"); expect(output).not.toContain(target); expect(output).not.toContain(remote);
    } finally { if (prior === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = prior; }
  }
}, 120_000);

test("new resume survives an older confirmed abandon after shard metadata", async () => {
  const { remoteRealmAdmission } = await import("../src/memory/sync-placement-remote-admission.ts");
  const oldRoot = mkdtempSync(join(tmpdir(), "amem-029-remote-abandon-"));
  const archive = Bun.spawnSync(["git", "archive", "57a4ace57bdf5c4fc12996146c76843de4ee21cc"], { stdout: "pipe", stderr: "pipe" });
  expect(archive.exitCode, archive.stderr.toString()).toBe(0);
  const extract = Bun.spawnSync(["tar", "-x", "-C", oldRoot], { stdin: archive.stdout, stdout: "ignore", stderr: "pipe" });
  expect(extract.exitCode, extract.stderr.toString()).toBe(0);
  const oldAdmission = await import(pathToFileURL(join(oldRoot, "src/memory/sync-placement-realm-admission.ts")).href);
  const shared = "example.test/adoption-old-abandon/shared", target = "example.test/adoption-old-abandon/target";
  try {
    const a = await inventoryFixture(2, [shared, target], true), remote = bareRemote(); expect((await sync(a.home, a.opts(remote))).ok).toBe(true);
    for (const stage of ["after-intent", "after-metadata", "after-proof"] as const) {
      const b = await inventoryFixture(1, [shared], true, [oldRoot]); expect((await sync(b.home, b.opts(remote))).ok).toBe(true);
      await expect(remoteRealmAdmission(b.home, target, { mode: "apply", visibility: privateVisibility, checkpoint: at => {
        if (at === stage) throw Error("isolated crash seam");
      } })).rejects.toThrow();
      expect(await oldAdmission.applyRealmAdmission(b.home, target, { mode: "abandon", confirm: true })).toMatchObject({ state: "abandoned" });
      expect(await remoteRealmAdmission(b.home, target, { mode: "resume", visibility: privateVisibility })).toMatchObject({ state: "admitted" });
      const targetStore = openShardStore({ memoryDir: b.home, project: target, deferPromotions: true });
      try { expect(targetStore.list({ project: target }).map(row => row.text)).toContain(`inventory note for ${target}`); } finally { targetStore.close(); }
    }
  } finally { rmSync(oldRoot, { recursive: true, force: true }); }
}, 240_000);

test("a concurrent admission after remote preview returns already-admitted without creating a companion", async () => {
  const { remoteRealmAdmission } = await import("../src/memory/sync-placement-remote-admission.ts");
  const { applyRealmAdmission } = await import("../src/memory/sync-placement-realm-admission.ts");
  const shared = "example.test/adoption-preview-race/shared", target = "example.test/adoption-preview-race/target";
  const a = await inventoryFixture(2, [shared, target], true), b = await inventoryFixture(1, [shared], true), remote = bareRemote();
  expect((await sync(a.home, a.opts(remote))).ok).toBe(true); expect((await sync(b.home, b.opts(remote))).ok).toBe(true);
  const result = await remoteRealmAdmission(b.home, target, { mode: "apply", visibility: privateVisibility, checkpoint: async stage => {
    if (stage === "after-preview") expect(await applyRealmAdmission(b.home, target, { mode: "apply" })).toMatchObject({ state: "admitted" });
  } });
  expect(result).toMatchObject({ state: "already-admitted", nextStep: "amem sync" });
  expect(readdirSync(b.home).filter(name => name.includes("placement-remote-adoption-")).length).toBe(0);
  expect(readFileSync(join(b.home, "placement-realm-extensions.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
}, 120_000);

test("confirmed abandon uses cached proof when the remote ref disappears", async () => {
  const { remoteRealmAdmission } = await import("../src/memory/sync-placement-remote-admission.ts");
  const shared = "example.test/adoption-offline/shared", target = "example.test/adoption-offline/target";
  const a = await inventoryFixture(2, [shared, target], true), b = await inventoryFixture(1, [shared], true), remote = bareRemote();
  expect((await sync(a.home, a.opts(remote))).ok).toBe(true); expect((await sync(b.home, b.opts(remote))).ok).toBe(true);
  await expect(remoteRealmAdmission(b.home, target, { mode: "apply", visibility: privateVisibility, checkpoint: stage => {
    if (stage === "after-stage") throw Error("fixture interruption");
  } })).rejects.toThrow();
  const removed = memoryGitSync(["--git-dir", remote, "update-ref", "-d", `refs/heads/amem/p/${shardKeyHash(target)}`], { encoding: "utf8" });
  expect(removed.status).toBe(0);
  expect(await remoteRealmAdmission(b.home, target, { mode: "abandon", confirm: true })).toMatchObject({ state: "abandoned" });
  expect(existsSync(join(shardDir(b.home, target), "generation.json"))).toBe(false);
  expect(readdirSync(b.home).filter(name => name.includes("placement-remote-adoption-")).length).toBe(0);
}, 120_000);

test("remote staging refuses a changed journal frontier before admission", async () => {
  const { remoteRealmAdmission } = await import("../src/memory/sync-placement-remote-admission.ts");
  const { captureSyncPlacementContext } = await import("../src/memory/sync-placement-capture.ts");
  const { holdPlacementRow, readPlacementProjection } = await import("../src/memory/sync-placement-journal.ts");
  const shared = "example.test/adoption-drift/shared", target = "example.test/adoption-drift/target";
  const a = await inventoryFixture(2, [shared, target], true), b = await inventoryFixture(1, [shared], true), remote = bareRemote();
  expect((await sync(a.home, a.opts(remote))).ok).toBe(true); expect((await sync(b.home, b.opts(remote))).ok).toBe(true);
  await expect(remoteRealmAdmission(b.home, target, { mode: "apply", visibility: privateVisibility, checkpoint: stage => {
    if (stage === "after-stage") throw Error("fixture interruption");
  } })).rejects.toThrow();
  const opts = b.opts(remote), port = { attest: opts.placementAttestation!, policyVersion: opts.policyVersion!, authorize: () => true };
  const capture = captureSyncPlacementContext(b.home, port), source = [...capture.rows.values()].find(row => row.key.realm.scope === "project")!;
  const prior = readPlacementProjection(b.home, b.epochHash);
  holdPlacementRow(b.home, { epochHash: b.epochHash, expectedHead: prior.headHash, requestId: "a".repeat(64), key: source.key }, port, "person");
  await expect(remoteRealmAdmission(b.home, target, { mode: "resume", visibility: privateVisibility })).rejects.toThrow();
  expect(existsSync(join(shardDir(b.home, target), "generation.json"))).toBe(false);
  expect(await remoteRealmAdmission(b.home, target, { mode: "abandon", confirm: true })).toMatchObject({ state: "abandoned" });
}, 120_000);

test("remote staging refuses a changed writer install before admission", async () => {
  const { remoteRealmAdmission } = await import("../src/memory/sync-placement-remote-admission.ts");
  const shared = "example.test/adoption-writer/shared", target = "example.test/adoption-writer/target";
  const a = await inventoryFixture(2, [shared, target], true), b = await inventoryFixture(1, [shared], true), remote = bareRemote();
  expect((await sync(a.home, a.opts(remote))).ok).toBe(true); expect((await sync(b.home, b.opts(remote))).ok).toBe(true);
  await expect(remoteRealmAdmission(b.home, target, { mode: "apply", visibility: privateVisibility, checkpoint: stage => {
    if (stage === "after-stage") throw Error("fixture interruption");
  } })).rejects.toThrow();
  appendFileSync(join(b.extraWriterRoot!, "src", "index.ts"), "// writer changed after staging\n");
  await expect(remoteRealmAdmission(b.home, target, { mode: "resume", visibility: privateVisibility })).rejects.toThrow();
  expect(existsSync(join(shardDir(b.home, target), "generation.json"))).toBe(false);
  expect(await remoteRealmAdmission(b.home, target, { mode: "abandon", confirm: true })).toMatchObject({ state: "abandoned" });
}, 120_000);

test("remote staging refuses source or policy drift and remains abandonable", async () => {
  const { remoteRealmAdmission } = await import("../src/memory/sync-placement-remote-admission.ts");
  const { writeFileSync } = await import("node:fs");
  const shared = "example.test/adoption-policy/shared", target = "example.test/adoption-policy/target";
  const a = await inventoryFixture(2, [shared, target], true), remote = bareRemote(); expect((await sync(a.home, a.opts(remote))).ok).toBe(true);
  for (const drift of ["source", "policy"] as const) {
    const b = await inventoryFixture(1, [shared], true); expect((await sync(b.home, b.opts(remote))).ok).toBe(true);
    await expect(remoteRealmAdmission(b.home, target, { mode: "apply", visibility: privateVisibility, checkpoint: stage => {
      if (stage === "after-stage") throw Error("fixture interruption");
    } })).rejects.toThrow();
    if (drift === "policy") writeFileSync(join(b.home, "amem.config.json"), JSON.stringify({ piiPatterns: ["NEW_PRIVATE_PATTERN"] }) + "\n", { mode: 0o600 });
    else {
      const writer = openShardStore({ memoryDir: b.home, project: shared, deferPromotions: true });
      try { writer.note({ op: "note", project: shared, scope: "project", tier: "long", kind: "finding", peer: "person", source: "person", text: "changed after preview", about: [] }); }
      finally { writer.close(); }
    }
    await expect(remoteRealmAdmission(b.home, target, { mode: "resume", visibility: privateVisibility })).rejects.toThrow();
    expect(existsSync(join(shardDir(b.home, target), "generation.json"))).toBe(false);
    expect(await remoteRealmAdmission(b.home, target, { mode: "abandon", confirm: true })).toMatchObject({ state: "abandoned" });
  }
}, 120_000);
