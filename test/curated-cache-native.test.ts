import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { briefCacheFile, readBriefCache, writeBriefCache } from "../src/brief-cache.ts";
import { machineId, MemoryStore } from "../src/memory/store.ts";
import { migrate } from "../src/memory/migrate.ts";
import { WorkListStore } from "../src/memory/work-lists.ts";
import { captureShardDir } from "../src/memory/shard.ts";
import { indexFileName } from "../src/memory/index-file.ts";

const roots: string[] = [], G = "f".repeat(32), project = "curated/native-fixture";
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amem-curated-native-")); roots.push(root);
  const base = join(root, "memory"), isolated = join(root, "runtime");
  const initial = new MemoryStore({ memoryDir: base, deferPromotions: true }); initial.close();
  await migrate({ memoryDir: base, generation: G, mode: "apply", authorizedPerson: true, tty: true });
  const store = new MemoryStore({ memoryDir: base, deferPromotions: true });
  try {
    store.note({ op: "note", project, scope: "project", tier: "long", kind: "decision", peer: "person", source: "person",
      title: "native title", text: `curated evidence ${"x".repeat(180)}`, about: [] });
    const work = new WorkListStore({ base, project, policy: () => true });
    try { await work.write("native queue", { task: "work first marker", status: "doing" }); } finally { work.close(); }
    store.prepareCuratedBriefs([project]);
    const machine = machineId(base).id, directory = captureShardDir(base, project, machine), binding = { directory, project, section: "curated" as const };
    const cache = readBriefCache(binding);
    if (!cache) throw new Error("fixture curated cache was not prepared");
    const indexFile = join(store.profile.dir, indexFileName(!!store.profile.foreignPruneFormat));
    const sourceLog = join(store.profile.dir, "log", `${store.machine.id}.jsonl`);
    cpSync(join(import.meta.dir, "../src"), join(isolated, "src"), { recursive: true });
    writeFileSync(join(isolated, "package.json"), JSON.stringify({ name: "amem-native-fixture", version: "99.0.0", type: "module" }));
    writeFileSync(join(isolated, "run.ts"), `
import { writeFileSync } from "node:fs";
import { sessionStartBrief } from "./src/session-brief.ts";
import { processSignature } from "./src/memory/platform.ts";
const [base,cwd,project,mode] = Bun.argv.slice(2), nativeSession = { signature: processSignature(process.pid)! };
const options = { base, cwd, project, nativeSession, timeRemaining: () => 1000 };
const native = await sessionStartBrief(options);
const library = mode === "native-only" ? undefined : await sessionStartBrief({ base, cwd, project });
const curated = (result:any) => result.context.split("\\n").filter((line:string)=>line.startsWith('{"section":"curated"')).map((line:string)=>JSON.parse(line));
const workLine = native.context.split("\\n").find((line:string)=>line.startsWith('{"section":"work"'));
const header = native.context.split("\\n")[0] || "";
const tight = await sessionStartBrief({ ...options, maxTokens: 500 });
const order:string[] = [];
let remaining = 1000;
const screened = await sessionStartBrief({ ...options, timeRemaining: () => remaining, policy: { host: { screen: async (value:unknown) => {
  const text = JSON.stringify(value);
  if (text.includes("curated evidence")) order.push("curated");
  if (text.includes("work first marker")) { order.push("work"); remaining = -1; }
  return true;
} } } });
writeFileSync(${JSON.stringify(join(root, "child-result.json"))}, JSON.stringify({ native, library, nativeCurated: curated(native), libraryCurated: library ? curated(library) : undefined, tight, order, screened }));
`);
    writeFileSync(join(base, "formats.json"), JSON.stringify([{ surface: "curated", minReader: "0.24.0", since: "fixture" }]));
    return { root, base, isolated, binding, cache, indexFile, sourceLog };
  } finally { store.close(); }
}

function run(f: Awaited<ReturnType<typeof fixture>>, mode = "all") {
  const result = Bun.spawnSync(["bun", join(f.isolated, "run.ts"), f.base, f.root, project, mode], { cwd: f.isolated, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`isolated future runtime failed (${result.exitCode}): ${result.stderr.toString()}`);
  return JSON.parse(readFileSync(join(f.root, "child-result.json"), "utf8")) as {
    native: { context: string; coverage: Record<string, string> };
    library: { context: string; coverage: Record<string, string> };
    nativeCurated: unknown[]; libraryCurated: unknown[];
    tight: { context: string; coverage: Record<string, string> };
    order: string[]; screened: { context: string };
  };
}

test("isolated future reader matches library curated output and pre-screens before work, then emits after work", async () => {
  const f = await fixture(), result = run(f);
  expect(result.nativeCurated).toEqual(result.libraryCurated);
  expect(result.native.context.indexOf('"section":"work"')).toBeLessThan(result.native.context.indexOf('"section":"curated"'));
  expect(result.order.indexOf("curated")).toBeGreaterThanOrEqual(0);
  expect(result.order.indexOf("curated")).toBeLessThan(result.order.indexOf("work"));
  expect(result.screened.context.indexOf('"section":"work"')).toBeLessThan(result.screened.context.indexOf('"section":"curated"'));
  expect(result.tight.context).toContain("work first marker");
  expect(result.tight.context).not.toContain('"section":"curated"');
  expect(result.tight.coverage.curated).toBe("partial");
});

test("current standalone policy narrows cached rows and missing or stale reads do not rewrite cache", async () => {
  const f = await fixture(), file = briefCacheFile(f.binding);
  writeFileSync(join(f.base, "amem.config.json"), JSON.stringify({ piiPatterns: ["curated evidence"] }));
  const filtered = run(f, "native-only");
  expect(filtered.native.context).not.toContain("curated evidence");
  expect(filtered.native.coverage.curated).toBe("partial");

  rmSync(join(f.root, "child-result.json"), { force: true });
  writeFileSync(join(f.base, "amem.config.json"), "{}");
  const stale = readBriefCache(f.binding)!;
  writeBriefCache(f.binding, { ...stale, curated: { ...stale.curated!, binding: "stale-profile" } });
  const beforeStale = readFileSync(file);
  const staleResult = run(f, "native-only");
  expect(staleResult.native.coverage.curated).toBe("unavailable");
  expect(staleResult.native.context).not.toContain("curated evidence");
  expect(readFileSync(file)).toEqual(beforeStale);

  rmSync(file);
  const missingResult = run(f, "native-only");
  expect(missingResult.native.coverage.curated).toBe("unavailable");
  expect(existsSync(file)).toBe(false);
});

test("fake 99.0.0 reader admits curated and home floors at 0.24.0 and 0.24.1, rejects lower and above-reader floors", async () => {
  const f = await fixture(), file = join(f.base, "formats.json");
  expect(JSON.parse(readFileSync(join(f.isolated, "package.json"), "utf8")).version).toBe("99.0.0");
  for (const surface of ["curated", "home"] as const) {
    for (const [minReader, expected] of [["0.23.9", false], ["0.24.0", true], ["0.24.1", true], ["100.0.0", false]] as const) {
      writeFileSync(file, JSON.stringify([{ surface, minReader, since: "fixture" }]));
      const result = run(f, "native-only");
      expect(result.native.coverage.curated, `${surface} ${minReader}`).toBe(expected ? "complete" : "unavailable");
      if (!expected) expect(result.native.context).not.toContain("curated evidence");
    }
  }
});

test("native-only cached brief ignores a malformed selected index and preserves cache and source bytes", async () => {
  const f = await fixture(), cacheFile = briefCacheFile(f.binding);
  writeFileSync(f.indexFile, "malformed selected curated index database");
  const beforeIndex = readFileSync(f.indexFile), beforeSource = readFileSync(f.sourceLog), beforeCache = readFileSync(cacheFile);
  const result = run(f, "native-only");
  expect(result.native.context).toContain("curated evidence");
  expect(result.native.context).toContain('"section":"curated"');
  expect(readFileSync(f.indexFile)).toEqual(beforeIndex);
  expect(readFileSync(f.sourceLog)).toEqual(beforeSource);
  expect(readFileSync(cacheFile)).toEqual(beforeCache);
});
