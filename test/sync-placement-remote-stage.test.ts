import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJSON } from "../src/memory/generation.ts";
import { acquireMutation } from "../src/memory/mutation.ts";
import { realPath } from "../src/memory/platform.ts";
import { ensureShardDescriptor, shardDir } from "../src/memory/shard.ts";
import { createRemoteAdoption, REMOTE_ADOPTION_SCHEMA } from "../src/memory/sync-placement-remote-adoption-format.ts";
import { clearRemoteAdoption, clearRemoteAdoptionPending, discardRemoteInstalledLog, inspectRemoteAdoptionPending, installRemoteAdoptionLog, readRemoteAdoption, stageRemoteAdoption, writeRemoteAdoption } from "../src/memory/sync-placement-remote-stage.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const home = realPath(mkdtempSync(join(tmpdir(), "amem-remote-stage-"))); roots.push(home);
  mkdirSync(join(home, "projects"), { mode: 0o700 });
  const project = "example.test/private-stage", bytes = Buffer.from('{"test":"synthetic"}\n'), name = `sync-${sha(bytes)}.jsonl`;
  const plan = createRemoteAdoption({ schema: REMOTE_ADOPTION_SCHEMA, homeHash: "1".repeat(64), epochHash: "2".repeat(64), generation: "3".repeat(32), keyHash: sha(project),
    remoteHash: "4".repeat(64), remoteHead: "5".repeat(40), sourceHash: "8".repeat(64), policyHash: "6".repeat(64), aliasesHash: "7".repeat(64), omitted: 1, packs: [{ name, bytes: bytes.length }] });
  const mutation = acquireMutation(home); if (!mutation) throw Error("fixture lock unavailable");
  const proof = { mutation, assertCurrent() {} }, packs = [{ name, bytes }];
  const root = join(home, `.placement-remote-adoption-${plan.keyHash}-${plan.seal}.stage`);
  return { home, project, plan, proof, packs, root, close: mutation };
}

test("stage and atomic log rename preserve existing work and capture", () => {
  const f = fixture();
  try {
    ensureShardDescriptor(f.home, f.project); const project = shardDir(f.home, f.project);
    mkdirSync(join(project, "work"), { mode: 0o700 }); mkdirSync(join(project, "machine"), { mode: 0o700 });
    writeFileSync(join(project, "work", "keep"), "work", { mode: 0o600 }); writeFileSync(join(project, "machine", "keep"), "capture", { mode: 0o600 });
    writeRemoteAdoption(f.home, f.plan, f.proof); stageRemoteAdoption(f.home, f.plan, f.packs, f.proof);
    expect(readRemoteAdoption(f.home, f.plan.keyHash)).toEqual(f.plan); expect(existsSync(join(project, "log"))).toBe(false);
    const before = lstatSync(join(f.root, "log"), { bigint: true }), target = lstatSync(project, { bigint: true }); expect(before.dev).toBe(target.dev);
    installRemoteAdoptionLog(f.home, f.project, f.plan, f.proof);
    const after = lstatSync(join(project, "log"), { bigint: true }); expect(after.ino).toBe(before.ino); expect(after.dev).toBe(before.dev);
    installRemoteAdoptionLog(f.home, f.project, f.plan, f.proof); // a crash after the atomic rename resumes without another write
    expect(lstatSync(join(project, "log"), { bigint: true }).ino).toBe(after.ino);
    expect(readFileSync(join(project, "log", f.packs[0]!.name))).toEqual(f.packs[0]!.bytes);
    expect(readFileSync(join(project, "work", "keep"), "utf8")).toBe("work"); expect(readFileSync(join(project, "machine", "keep"), "utf8")).toBe("capture");
    expect(existsSync(join(project, "generation.json"))).toBe(false);
  } finally { f.close(); }
});

test("an existing curated subpath or redirected scaffold refuses before publication", () => {
  for (const kind of ["existing", "symlink"] as const) {
    const f = fixture();
    try {
      ensureShardDescriptor(f.home, f.project); const project = shardDir(f.home, f.project), target = join(project, "log");
      if (kind === "existing") { mkdirSync(target, { mode: 0o700 }); writeFileSync(join(target, "keep"), "untouched", { mode: 0o600 }); }
      else symlinkSync(f.root, target);
      writeRemoteAdoption(f.home, f.plan, f.proof); stageRemoteAdoption(f.home, f.plan, f.packs, f.proof);
      expect(() => installRemoteAdoptionLog(f.home, f.project, f.plan, f.proof)).toThrow(kind === "existing" ? /curated subpath: log/ : /path/);
      expect(existsSync(join(f.root, "log", f.packs[0]!.name))).toBe(true);
      if (kind === "existing") expect(readFileSync(join(target, "keep"), "utf8")).toBe("untouched");
      else expect(lstatSync(target).isSymbolicLink()).toBe(true);
    } finally { f.close(); }
  }
});

test("torn companion and pack prefixes finish exactly while conflicting bytes refuse", () => {
  const f = fixture();
  try {
    const expected = Buffer.from(canonicalJSON(f.plan) + "\n"), file = join(f.home, `placement-remote-adoption-${f.plan.keyHash}.json.${f.plan.seal}.pending`);
    writeFileSync(file, expected.subarray(0, 17), { mode: 0o600 }); writeRemoteAdoption(f.home, f.plan, f.proof);
    mkdirSync(f.root, { mode: 0o700 }); mkdirSync(join(f.root, "log"), { mode: 0o700 });
    const pack = join(f.root, "log", f.packs[0]!.name); writeFileSync(pack, f.packs[0]!.bytes.subarray(0, 4), { mode: 0o600 });
    stageRemoteAdoption(f.home, f.plan, f.packs, f.proof); expect(readFileSync(pack)).toEqual(f.packs[0]!.bytes);
    writeFileSync(pack, "conflict", { mode: 0o600 }); expect(() => stageRemoteAdoption(f.home, f.plan, f.packs, f.proof)).toThrow();
    expect(readFileSync(pack, "utf8")).toBe("conflict");
  } finally { f.close(); }
});

test("abandon removes only attributable private staging and never an installed log", () => {
  for (const installed of [false, true]) {
    const f = fixture();
    try {
      writeRemoteAdoption(f.home, f.plan, f.proof); stageRemoteAdoption(f.home, f.plan, f.packs, f.proof);
      if (installed) installRemoteAdoptionLog(f.home, f.project, f.plan, f.proof);
      const unrelated = join(f.root, "unrelated"); writeFileSync(unrelated, "retain", { mode: 0o600 });
      expect(() => clearRemoteAdoption(f.home, f.plan, f.packs, f.proof)).toThrow();
      expect(readFileSync(unrelated, "utf8")).toBe("retain"); rmSync(unrelated);
      clearRemoteAdoption(f.home, f.plan, f.packs, f.proof);
      expect(readRemoteAdoption(f.home, f.plan.keyHash)).toBeUndefined(); expect(existsSync(f.root)).toBe(false);
      if (installed) expect(readFileSync(join(shardDir(f.home, f.project), "log", f.packs[0]!.name))).toEqual(f.packs[0]!.bytes);
    } finally { f.close(); }
  }
});

test("a torn unrelated companion stage refuses a new plan and is removed only after exact recheck", () => {
  const f = fixture();
  try {
    const pending = join(f.home, `placement-remote-adoption-${f.plan.keyHash}.json.${"a".repeat(64)}.pending`);
    writeFileSync(pending, "partial", { mode: 0o600 }); const inspected = inspectRemoteAdoptionPending(f.home, f.plan.keyHash);
    expect(inspected).toHaveLength(1); expect(() => writeRemoteAdoption(f.home, f.plan, f.proof)).toThrow();
    writeFileSync(pending, "changed", { mode: 0o600 });
    expect(() => clearRemoteAdoptionPending(f.home, f.plan.keyHash, inspected, f.proof)).toThrow();
    expect(readFileSync(pending, "utf8")).toBe("changed");
    clearRemoteAdoptionPending(f.home, f.plan.keyHash, inspectRemoteAdoptionPending(f.home, f.plan.keyHash), f.proof);
    expect(existsSync(pending)).toBe(false); writeRemoteAdoption(f.home, f.plan, f.proof);
  } finally { f.close(); }
});

test("confirmed pre-admission cleanup removes only exact installed packs", () => {
  const f = fixture();
  try {
    ensureShardDescriptor(f.home, f.project); const project = shardDir(f.home, f.project);
    mkdirSync(join(project, "work"), { mode: 0o700 }); writeFileSync(join(project, "work", "keep"), "work", { mode: 0o600 });
    writeRemoteAdoption(f.home, f.plan, f.proof); stageRemoteAdoption(f.home, f.plan, f.packs, f.proof); installRemoteAdoptionLog(f.home, f.project, f.plan, f.proof);
    const pack = join(project, "log", f.packs[0]!.name); writeFileSync(pack, "changed", { mode: 0o600 });
    expect(() => discardRemoteInstalledLog(f.home, f.project, f.plan, f.proof)).toThrow(); expect(readFileSync(pack, "utf8")).toBe("changed");
    writeFileSync(pack, f.packs[0]!.bytes, { mode: 0o600 }); discardRemoteInstalledLog(f.home, f.project, f.plan, f.proof);
    expect(existsSync(join(project, "log"))).toBe(false); expect(readFileSync(join(project, "work", "keep"), "utf8")).toBe("work");
    clearRemoteAdoption(f.home, f.plan, f.packs, f.proof);
  } finally { f.close(); }
});

test("confirmed pre-admission cleanup resumes after a pack was already removed", () => {
  const f = fixture();
  try {
    writeRemoteAdoption(f.home, f.plan, f.proof); stageRemoteAdoption(f.home, f.plan, f.packs, f.proof); installRemoteAdoptionLog(f.home, f.project, f.plan, f.proof);
    const log = join(shardDir(f.home, f.project), "log"); rmSync(join(log, f.packs[0]!.name));
    discardRemoteInstalledLog(f.home, f.project, f.plan, f.proof); expect(existsSync(log)).toBe(false);
    clearRemoteAdoption(f.home, f.plan, f.packs, f.proof); expect(readRemoteAdoption(f.home, f.plan.keyHash)).toBeUndefined();
  } finally { f.close(); }
});

test("a cross-device staged log refuses before rename", () => {
  const f = fixture();
  try {
    ensureShardDescriptor(f.home, f.project); writeRemoteAdoption(f.home, f.plan, f.proof); stageRemoteAdoption(f.home, f.plan, f.packs, f.proof);
    const staged = join(f.root, "log"), original = fs.lstatSync;
    const fake = ((...args: unknown[]) => {
      const stat = (original as (...input: unknown[]) => fs.BigIntStats)(...args);
      if (String(args[0]) === staged && typeof stat.dev === "bigint") Object.defineProperty(stat, "dev", { value: stat.dev + 1n });
      return stat;
    }) as typeof fs.lstatSync;
    const spy = spyOn(fs, "lstatSync").mockImplementation(fake);
    try { expect(() => installRemoteAdoptionLog(f.home, f.project, f.plan, f.proof)).toThrow(); } finally { spy.mockRestore(); }
    expect(existsSync(join(f.root, "log", f.packs[0]!.name))).toBe(true);
    expect(existsSync(join(shardDir(f.home, f.project), "log"))).toBe(false);
  } finally { f.close(); }
});
