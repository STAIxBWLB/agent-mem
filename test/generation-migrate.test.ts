import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, entryId } from "../src/memory/store.ts";
import { processSignature, realPath } from "../src/memory/platform.ts";
import { canonicalJSON, generationDir, readProfileJSON, resolveProfile, selectorRevision, writeProfileJSON } from "../src/memory/generation.ts";
import { acquireMutation } from "../src/memory/mutation.ts";
import { migrate, readMigrationPrefix, type MigrateOptions } from "../src/memory/migrate.ts";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const G = "a".repeat(32), OTHER = "b".repeat(32), NOW = Date.parse("2026-10-18T00:00:00Z");
function temporary() { const home = realPath(mkdtempSync(join(tmpdir(), "amem-migration-"))); homes.push(home); return home; }
function fixture() {
  const home = temporary(), store = new MemoryStore({ home, now: () => NOW, deferPromotions: true, profile: "shared-v1" });
  const id = store.note({ op: "note", project: "agent-hub", scope: "project", tier: "long", kind: "contract", peer: "person", source: "person", text: "preserve original authored bytes", about: ["path:src/public.ts"] });
  const memoryDir = store.dir, machine = store.machine.id;
  store.close();
  return { home, memoryDir, id, machine, segment: join(memoryDir, "log", `${machine}.jsonl`) };
}
function files(dir: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (root: string, relative = "") => {
    for (const name of readdirSync(root).sort()) {
      const path = join(root, name), key = relative ? `${relative}/${name}` : name, stat = lstatSync(path);
      if (stat.isDirectory()) visit(path, key);
      else if (stat.isFile()) result[key] = readFileSync(path).toString("base64");
    }
  };
  visit(dir); return result;
}
function legacyBytes(memoryDir: string): Record<string, string> {
  return Object.fromEntries(Object.entries(files(memoryDir)).filter(([key]) => key.startsWith("log/") || key.startsWith("local/") || key === "machine.json" || /^index\.db(?:-|$)/.test(key)));
}
const options = (memoryDir: string, extra: Partial<MigrateOptions> = {}): MigrateOptions => ({ memoryDir, mode: "apply", generation: G, authorizedPerson: true, tty: true, now: () => NOW, ...extra });

test("profile defaults support a nonexistent home and malformed selectors never silently fall back", () => {
  const root = temporary(), missing = join(root, "not-created", "memory");
  expect(resolveProfile(missing)).toMatchObject({ kind: "shared-v1", home: missing, dir: missing, selectorRevision: "absent" });
  expect(existsSync(join(root, "not-created"))).toBe(false);
  const { memoryDir } = fixture();
  writeFileSync(join(memoryDir, "profile.json"), "{bad JSON");
  expect(() => resolveProfile(memoryDir)).toThrow("profile");
  writeProfileJSON(join(memoryDir, "profile.json"), { schema: "agent-mem.profile/v1", kind: "generation", generation: G });
  expect(() => resolveProfile(memoryDir)).toThrow("profile");
  for (const generation of ["../escape", "A".repeat(32), "a".repeat(31)]) expect(() => resolveProfile(memoryDir, { generation })).toThrow();
});

test("migration dry-run is byte-unchanged, counts partial tails/malformed rows and never opens a legacy index", async () => {
  const { memoryDir, segment } = fixture();
  appendFileSync(segment, "{bad JSON}\nunfinished tail");
  const before = files(memoryDir);
  const result = await migrate(options(memoryDir, { mode: "dry-run" }));
  expect(result.profile.kind).toBe("shared-v1");
  expect(result.counts).toMatchObject({ validRows: 1, skippedRows: 1, tailBytes: Buffer.byteLength("unfinished tail") });
  expect(files(memoryDir)).toEqual(before);
  expect(existsSync(join(memoryDir, "profile.lock"))).toBe(false);
  expect(existsSync(join(memoryDir, "generations"))).toBe(false);
});

test("actual migration seals before selecting, preserves legacy bytes, and explicitly reactivates the same generation", async () => {
  const { memoryDir, id } = fixture(), before = legacyBytes(memoryDir);
  const applied = await migrate(options(memoryDir));
  expect(applied.profile).toMatchObject({ kind: "generation", home: memoryDir, dir: join(memoryDir, "generations", G), generation: G });
  expect(applied.profile.selectorRevision).toBe(selectorRevision(memoryDir));
  expect(readProfileJSON(join(applied.profile.dir, "generation-seal.json"))).toMatchObject({ generation: G });
  expect(legacyBytes(memoryDir)).toEqual(before);
  const current = new MemoryStore({ home: join(memoryDir, ".."), profile: { generation: G }, deferPromotions: true });
  try { expect(current.get(id, "agent-hub")?.text).toBe("preserve original authored bytes"); }
  finally { current.close(); }
  const repeated = await migrate(options(memoryDir)); expect(repeated.alreadyActive).toBe(true);
  expect((await migrate(options(memoryDir, { mode: "deactivate" }))).profile.kind).toBe("shared-v1");
  expect(existsSync(applied.profile.dir)).toBe(true);
  expect((await migrate(options(memoryDir))).profile.generation).toBe(G);
  expect(legacyBytes(memoryDir)).toEqual(before);
});

test("build interruption resumes the recorded G; ordinary apply cannot invent a second staging generation", async () => {
  const { memoryDir } = fixture();
  let captured: string | undefined;
  await expect(migrate(options(memoryDir, { buildIndex: profile => { captured = profile.generation; throw new Error("synthetic build crash"); } }))).rejects.toThrow("synthetic build crash");
  expect(captured).toBe(G); expect(resolveProfile(memoryDir).kind).toBe("shared-v1");
  expect(existsSync(join(generationDir(memoryDir, G), "generation-seal.json"))).toBe(false);
  await expect(migrate(options(memoryDir, { generation: OTHER }))).rejects.toThrow("resume");
  expect(readdirSync(join(memoryDir, "generations"))).toEqual([G]);
  const resumed = await migrate(options(memoryDir, { mode: "resume" }));
  expect(resumed.profile.generation).toBe(G);
  expect((await migrate(options(memoryDir, { mode: "resume" }))).alreadyActive).toBe(true);
});

test("prefix mutation and selector CAS conflicts prevent activation after a successful build hook", async () => {
  for (const fault of ["prefix", "selector"] as const) {
    const { memoryDir, segment } = fixture();
    await expect(migrate(options(memoryDir, { buildIndex: profile => {
      expect(profile.generation).toBe(G);
      if (fault === "prefix") writeFileSync(segment, readFileSync(segment, "utf8").replace("preserve", "replaced"));
      else writeProfileJSON(join(memoryDir, "profile.json"), { schema: "agent-mem.profile/v1", kind: "shared-v1" });
    } }))).rejects.toThrow();
    expect(resolveProfile(memoryDir).kind).toBe("shared-v1");
    expect((readProfileJSON(join(memoryDir, "migration.json")) as { generation: string }).generation).toBe(G);
  }
});

test("append-only suffix during build is retained as late bridge input without changing captured prefixes", async () => {
  const { memoryDir, segment, machine } = fixture();
  let sourceBytes = "";
  const core = await import("../src/memory/store.ts");
  const applied = await migrate(options(memoryDir, { buildIndex: (profile, sources, commit) => {
    const source = sources.find(row => row.path === `log/${machine}.jsonl`)!;
    sourceBytes = readMigrationPrefix(memoryDir, source).toString("utf8");
    const body = { schema: "agent-hub.memory/v1", op: "note", project: "agent-hub", scope: "project", tier: "long", kind: "finding", peer: "person", source: "person", text: "late legacy suffix", about: [], at: "2026-10-18T00:01:00.000Z", machine } as const;
    appendFileSync(segment, canonicalJSON({ ...body, id: entryId(body) }) + "\n");
    core.buildGenerationIndex(profile, sources, commit);
  } }));
  expect(applied.profile.generation).toBe(G);
  expect(readFileSync(segment, "utf8").startsWith(sourceBytes)).toBe(true);
  expect(readFileSync(segment, "utf8")).toContain("late legacy suffix");
});

test("corrupt seals and symlink metadata refuse selection without a fallback", async () => {
  const { memoryDir } = fixture();
  const applied = await migrate(options(memoryDir));
  const seal = join(applied.profile.dir, "generation-seal.json"), original = readFileSync(seal, "utf8");
  const value = JSON.parse(original); value.sourceDigest = "f".repeat(64); writeFileSync(seal, JSON.stringify(value));
  expect(() => resolveProfile(memoryDir)).toThrow("profile");
  writeFileSync(seal, original); rmSync(seal); symlinkSync(join(memoryDir, "machine.json"), seal);
  expect(() => resolveProfile(memoryDir)).toThrow("profile");
});

test("migration refuses non-person/non-TTY callers and a live profile lock is never stolen", async () => {
  const { memoryDir } = fixture();
  for (const extra of [{ authorizedPerson: false }, { tty: false }]) await expect(migrate(options(memoryDir, extra))).rejects.toThrow("authorized person");
  const signature = processSignature(process.pid)!;
  writeFileSync(join(memoryDir, "profile.lock"), JSON.stringify({ pid: process.pid, signature, token: "other-owner" }));
  await expect(migrate(options(memoryDir))).rejects.toThrow("live or unknown");
  expect(JSON.parse(readFileSync(join(memoryDir, "profile.lock"), "utf8")).token).toBe("other-owner");
  expect(existsSync(join(memoryDir, "generations"))).toBe(false);
}, 7000);

test("resume recreates a recorded staging directory without choosing another G", async () => {
  const { memoryDir } = fixture();
  await expect(migrate(options(memoryDir, { buildIndex: () => { throw new Error("staging boundary"); } }))).rejects.toThrow("staging boundary");
  // Reproduce the durable-journal / not-yet-created-directory boundary using only this isolated fixture.
  rmSync(generationDir(memoryDir, G), { recursive: true, force: true });
  const resumed = await migrate(options(memoryDir, { mode: "resume" }));
  expect(resumed.profile.generation).toBe(G);
  expect(readdirSync(join(memoryDir, "generations"))).toEqual([G]);
});

test("concurrent different-G migrations serialize then reject the stale selector revision", async () => {
  const { memoryDir } = fixture(), core = await import("../src/memory/store.ts");
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const first = migrate(options(memoryDir, { buildIndex: async (profile, sources, commit) => {
    core.buildGenerationIndex(profile, sources, commit); entered(); await barrier;
  } }));
  const firstOutcome = first.then(value => ({ value }), error => ({ error }));
  await started;
  let secondBuilt = false;
  const secondOutcome = migrate(options(memoryDir, { generation: OTHER, buildIndex: () => { secondBuilt = true; } })).then(value => ({ value }), error => ({ error }));
  release();
  const [a, b] = await Promise.all([firstOutcome, secondOutcome]);
  expect("value" in a && a.value.profile.generation).toBe(G);
  expect("error" in b).toBe(true);
  expect(secondBuilt).toBe(false);
  expect(existsSync(generationDir(memoryDir, OTHER))).toBe(false);
  expect(resolveProfile(memoryDir).generation).toBe(G);
});

test("reactivation binds machine id while preserving the generation's existing mutable label", async () => {
  const { memoryDir } = fixture();
  const first = await migrate(options(memoryDir));
  const original = readProfileJSON(join(first.profile.dir, "machine.json")) as { id: string; label: string };
  await migrate(options(memoryDir, { mode: "deactivate" }));
  writeProfileJSON(join(memoryDir, "machine.json"), { ...original, label: "new legacy label" });
  const reopened = await migrate(options(memoryDir));
  expect(reopened.profile.generation).toBe(G);
  expect(readProfileJSON(join(reopened.profile.dir, "machine.json"))).toEqual(original);
  expect(readProfileJSON(join(memoryDir, "machine.json"))).toEqual({ ...original, label: "new legacy label" });
});

test("two processes recover a confirmed-dead profile owner without overlapping their critical sections", async () => {
  const { memoryDir, home } = fixture();
  writeFileSync(join(memoryDir, "profile.lock"), JSON.stringify({ pid: process.pid, signature: "a previous process identity", token: "dead-owner" }));
  const events = join(home, "profile-events.jsonl"), start = join(home, "start-probes"), release = join(home, "release-owner");
  const module = join(import.meta.dir, "../src/memory/generation.ts");
  const children = ["first", "second"].map(who => {
    const wrapper = join(home, `${who}.ts`);
    writeFileSync(wrapper, `import {existsSync, writeFileSync, appendFileSync} from "node:fs";
import {withProfileLock} from ${JSON.stringify(module)};
writeFileSync(${JSON.stringify(join(home, `${who}.ready`))}, "ready");
const deadline = Date.now()+6000;
while (!existsSync(${JSON.stringify(start)})) { if(Date.now()>deadline) throw new Error("start barrier"); await Bun.sleep(5); }
await withProfileLock(${JSON.stringify(memoryDir)}, async()=>{
appendFileSync(${JSON.stringify(events)}, JSON.stringify({event:"enter",who:${JSON.stringify(who)}})+"\\n");
while (!existsSync(${JSON.stringify(release)})) { if(Date.now()>deadline) throw new Error("release barrier"); await Bun.sleep(5); }
appendFileSync(${JSON.stringify(events)}, JSON.stringify({event:"exit",who:${JSON.stringify(who)}})+"\\n");
});
`);
    return Bun.spawn([process.execPath, wrapper], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  });
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!condition() && Date.now() < deadline) await Bun.sleep(5);
    expect(condition()).toBe(true);
  };
  try {
    await until(() => ["first", "second"].every(who => existsSync(join(home, `${who}.ready`))));
    writeFileSync(start, "start");
    await until(() => existsSync(events) && readFileSync(events, "utf8").includes('"enter"'));
    writeFileSync(release, "release");
    const results = await Promise.all(children.map(async child => ({ code: await child.exited, stderr: await new Response(child.stderr).text() })));
    for (const result of results) expect(result.code, result.stderr).toBe(0);
    const rows = readFileSync(events, "utf8").trim().split("\n").map(line => JSON.parse(line) as { event: string; who: string });
    expect(rows.map(row => row.event)).toEqual(["enter", "exit", "enter", "exit"]);
    expect(rows[0]!.who).toBe(rows[1]!.who); expect(rows[2]!.who).toBe(rows[3]!.who);
    expect(rows[0]!.who).not.toBe(rows[2]!.who);
    expect(existsSync(join(memoryDir, "profile.lock"))).toBe(false);
  } finally { for (const child of children) if (child.exitCode === null) child.kill(); }
}, 10_000);


test("deactivation cannot switch the selector while its generation mutation fence is held", async () => {
  const { memoryDir } = fixture();
  const active = await migrate(options(memoryDir)), revision = selectorRevision(memoryDir);
  const release = acquireMutation(active.profile.dir);
  expect(release).toBeDefined();
  try {
    await expect(migrate(options(memoryDir, { mode: "deactivate" }))).rejects.toThrow("generation mutation lock is busy");
    expect(selectorRevision(memoryDir)).toBe(revision);
    expect(resolveProfile(memoryDir).generation).toBe(G);
  } finally { release?.(); }
  expect((await migrate(options(memoryDir, { mode: "deactivate" }))).profile.kind).toBe("shared-v1");
}, 7000);

test("explicit deactivate recovers a missing or corrupt selected generation without validating or rewriting it", async () => {
  for (const fault of ["missing", "descriptor", "seal"] as const) {
    const { memoryDir } = fixture();
    const selected = await migrate(options(memoryDir)), dir = selected.profile.dir;
    if (fault === "missing") rmSync(dir, { recursive: true, force: true });
    else writeFileSync(join(dir, fault === "descriptor" ? "generation.json" : "generation-seal.json"), "{corrupt metadata");
    const before = existsSync(dir) ? files(dir) : undefined;
    expect(() => resolveProfile(memoryDir)).toThrow();
    const recovered = await migrate(options(memoryDir, { mode: "deactivate" }));
    expect(recovered.profile.kind).toBe("shared-v1");
    expect(resolveProfile(memoryDir).kind).toBe("shared-v1");
    if (before) expect(files(dir)).toEqual(before);
    else expect(existsSync(dir)).toBe(false);
  }
});

for (const boundary of ["after-seal", "before-selector", "after-selector"] as const) test(`migration resumes the same G after a crash at ${boundary}`, async () => {
  const { memoryDir } = fixture(), before = legacyBytes(memoryDir);
  await expect(migrate(options(memoryDir, { checkpoint: stage => {
    if (stage === boundary) throw new Error(`synthetic crash at ${stage}`);
  } }))).rejects.toThrow(`synthetic crash at ${boundary}`);
  const journal = readProfileJSON(join(memoryDir, "migration.json")) as { generation: string; phase: string };
  expect(journal.generation).toBe(G); expect(journal.phase).toBe("sealed");
  expect(resolveProfile(memoryDir).kind).toBe(boundary === "after-selector" ? "generation" : "shared-v1");
  expect(existsSync(join(generationDir(memoryDir, G), "generation-seal.json"))).toBe(true);
  const resumed = await migrate(options(memoryDir, { mode: "resume" }));
  expect(resumed.profile.generation).toBe(G);
  expect((await migrate(options(memoryDir, { mode: "resume" }))).alreadyActive).toBe(true);
  expect(readdirSync(join(memoryDir, "generations"))).toEqual([G]);
  expect(legacyBytes(memoryDir)).toEqual(before);
});

test("a process exiting after the first generation append reopens the same G without touching v1", async () => {
  const { memoryDir, home } = fixture();
  await migrate(options(memoryDir));
  const before = legacyBytes(memoryDir), receipt = join(home, "first-generation-id.txt"), wrapper = join(home, "first-generation-append.ts");
  const module = join(import.meta.dir, "../src/memory/store.ts");
  writeFileSync(wrapper, `import {writeFileSync} from "node:fs";
const {MemoryStore}=await import(${JSON.stringify(module)});
const store=new MemoryStore({home:${JSON.stringify(home)},deferPromotions:true});
const id=store.note({op:"note",project:"agent-hub",scope:"project",tier:"long",kind:"decision",peer:"person",source:"person",text:"first generation write before process exit",about:[]});
writeFileSync(${JSON.stringify(receipt)},id);
process.exit(73);
`);
  const child = Bun.spawn([process.execPath, wrapper], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 5000);
  try {
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code, stderr).toBe(73);
  } finally { clearTimeout(timer); }
  const id = readFileSync(receipt, "utf8"), reopened = new MemoryStore({ home, deferPromotions: true });
  try {
    expect(reopened.profile.generation).toBe(G);
    expect(reopened.get(id, "agent-hub")?.text).toBe("first generation write before process exit");
    const incremental = reopened.derivedTables(); reopened.rebuild(); expect(reopened.derivedTables()).toEqual(incremental);
  } finally { reopened.close(); }
  expect((await migrate(options(memoryDir, { mode: "resume" }))).profile.generation).toBe(G);
  expect(readdirSync(join(memoryDir, "generations"))).toEqual([G]);
  expect(legacyBytes(memoryDir)).toEqual(before);
});

test("dry-run and apply skip the same complete malformed legacy lines without changing their bytes", async () => {
  const { memoryDir, segment } = fixture();
  appendFileSync(segment, '{not JSON}\n{"op":"unknown-legacy-op","id":"bad"}\n');
  const before = legacyBytes(memoryDir);
  const planned = await migrate(options(memoryDir, { mode: "dry-run" }));
  expect(planned.counts).toMatchObject({ validRows: 1, skippedRows: 2 });
  const applied = await migrate(options(memoryDir));
  expect(applied.counts).toMatchObject({ validRows: 1, skippedRows: 2 });
  expect(legacyBytes(memoryDir)).toEqual(before);
  expect(applied.profile.generation).toBe(G);
});
