import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realPath } from "../src/memory/platform.ts";

// #370: the brief's preference slot. A preference is a standing instruction, so it is shown by its own bounded slot instead of competing with
// intent- or path-ranked rows it has no anchor for. Both briefs are exercised by a reader at 99.0.0 beside its own copy of `src`: a home
// carrying the kind's floor is above this build's own version, and refused at store open by design (formats.ts).

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const PROBE = `
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildIntentBrief } from "./src/memory/intent-brief.ts";
import { createIntentBriefSource } from "./src/memory/recall.ts";
import { MemoryStore, machineId } from "./src/memory/store.ts";
import { captureShardDir } from "./src/memory/shard.ts";
import { readBriefCache } from "./src/brief-cache.ts";
import { sessionStartBrief } from "./src/session-brief.ts";
import { processSignature } from "./src/memory/platform.ts";

const job = JSON.parse(readFileSync(process.argv[2], "utf8"));
const clock = { t: Date.parse("2026-11-11T00:00:00.000Z") };
const store = new MemoryStore({ memoryDir: job.memory, deferPromotions: true, now: () => clock.t });
const out = {};
try {
  const pref = (text, over = {}) => { clock.t += 1000; return { op: "note", scope: "project", tier: "long", kind: "preference", peer: "person", source: "person", text, about: [], project: job.project, ...over }; };
  // Oldest first: one long rule that cannot fit its 240-byte amem_brief slot line, so it must be dropped whole rather than clipped.
  store.note(pref("long rule " + "x".repeat(400)));
  const kept = store.note(pref("answer in Korean"));
  const replaced = store.note(pref("temporary rule"));
  const forgottenId = store.note(pref("forgotten rule"));
  // A shared preference written under another project: every project reads it, so this brief must too.
  const shared = store.note(pref("never rewrite main without asking", { scope: "shared", project: job.other }));
  store.supersede(replaced, kept, "person", job.project);
  store.forget(forgottenId, "person", job.project);
  out.ids = { kept, shared, replaced };
  const source = createIntentBriefSource(store, job.project);
  const brief = await buildIntentBrief(source, { project: job.project, cwd: job.cwd, repo: "fixture", intent: "unrelated release notes", paths: [], maxBytes: 2048, policy: () => ({ screen: async () => true, screenStandalone: () => true }), policyVersion: () => "immutable", now: () => clock.t });
  const lines = brief.text ? brief.text.split("\\n") : [];
  out.brief = { kinds: brief.items.map(view => view.kind), ids: brief.items.map(view => view.id), truncated: brief.truncated, lines: lines.length,
    parsed: lines.slice(1).map(line => JSON.parse(line)), bytes: brief.bytes, textBytes: Buffer.byteLength(brief.text) };
  const tight = await buildIntentBrief(source, { project: job.project, cwd: job.cwd, repo: "fixture", intent: "unrelated release notes", paths: [], maxBytes: 200, policy: () => ({ screen: async () => true, screenStandalone: () => true }), policyVersion: () => "immutable", now: () => clock.t });
  out.tight = { text: tight.text, items: tight.items.length, truncated: tight.truncated };
  store.prepareCuratedBriefs([job.project]);
  const directory = captureShardDir(job.memory, job.project, machineId(job.memory).id);
  const preferences = readBriefCache({ directory, project: job.project, section: "preferences" });
  const curated = readBriefCache({ directory, project: job.project, section: "curated" });
  out.sidecar = { kinds: (preferences?.rows ?? []).map(row => row.data.kind), partial: (preferences?.rows ?? []).map(row => row.partial), binding: typeof preferences?.preferences?.binding, curatedRows: curated?.rows.length ?? -1 };
  const native = await sessionStartBrief({ base: job.memory, cwd: job.cwd, project: job.project, nativeSession: { signature: processSignature(process.pid) }, timeRemaining: () => 1000 });
  out.native = { kinds: native.context.split("\\n").filter(line => line.startsWith('{"section":"curated"')).map(line => JSON.parse(line).data.kind), coverage: native.coverage };
  // A person-recorded floor above this reader refuses the prebuilt slot before any of its rows is served.
  writeFileSync(join(job.memory, "formats.json"), JSON.stringify([{ surface: "curated", minReader: "100.0.0", since: "2026-11-11" }]) + "\\n");
  const aboveFloor = await sessionStartBrief({ base: job.memory, cwd: job.cwd, project: job.project, nativeSession: { signature: processSignature(process.pid) }, timeRemaining: () => 1000 });
  out.aboveFloor = { kinds: aboveFloor.context.split("\\n").filter(line => line.startsWith('{"section":"curated"')).map(line => JSON.parse(line).data.kind), coverage: aboveFloor.coverage };
} finally { store.close(); }
writeFileSync(job.out, JSON.stringify(out));
`;

test("amem_brief shows current preferences without an anchor, and the SessionStart sidecar carries the same rows", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-preference-brief-"))); roots.push(root);
  const memory = join(root, "memory"), cwd = join(root, "repo"), isolated = join(root, "future"), out = join(root, "probe.json"), job = join(root, "job.json");
  mkdirSync(memory, { recursive: true }); mkdirSync(join(cwd, ".git"), { recursive: true });
  // A person records the floor; amem never writes formats.json.
  writeFileSync(join(memory, "formats.json"), JSON.stringify([{ surface: "curated", minReader: "0.25.0", since: "2026-11-11" }]) + "\n");
  cpSync(join(import.meta.dir, "../src"), join(isolated, "src"), { recursive: true });
  writeFileSync(join(isolated, "package.json"), JSON.stringify({ name: "amem-preference-brief-probe", version: "99.0.0", type: "module" }));
  writeFileSync(join(isolated, "probe.ts"), PROBE);
  writeFileSync(job, JSON.stringify({ memory, cwd, project: "fixture/brief", other: "fixture/elsewhere", out }));
  const child = Bun.spawnSync([process.execPath, join(isolated, "probe.ts"), job], { cwd: isolated, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  expect(child.stderr.toString()).toBe("");
  expect(child.exitCode).toBe(0);
  const result = JSON.parse(readFileSync(out, "utf8")) as {
    ids: { kept: string; shared: string; replaced: string };
    brief: { kinds: string[]; ids: string[]; truncated: boolean; lines: number; parsed: { id: string; kind: string; text: string }[]; bytes: number; textBytes: number };
    tight: { text: string; items: number; truncated: boolean };
    sidecar: { kinds: string[]; partial: boolean[]; binding: string; curatedRows: number };
    native: { kinds: string[]; coverage: Record<string, string> };
    aboveFloor: { kinds: string[]; coverage: Record<string, string> };
  };
  // Current preferences only: the superseded and forgotten ones are left out, the shared one from another project is kept, and the rule too
  // long for its whole slot line is dropped rather than clipped into half a rule.
  expect(result.brief.kinds).toEqual(["preference", "preference"]);
  expect(result.brief.ids).toEqual([result.ids.shared, result.ids.kept]);
  expect(result.brief.parsed.map(line => line.kind)).toEqual(["preference", "preference"]);
  expect(result.brief.parsed.every(line => line.id.startsWith("mem:") && !line.text.includes("xxxx"))).toBe(true);
  expect(result.brief.truncated).toBe(true);
  expect(result.brief.bytes).toBe(result.brief.textBytes);
  // A budget too small for one whole line drops the slot entirely rather than cutting a rule in half.
  expect(result.tight.text).toBe("");
  expect(result.tight.items).toBe(0);
  expect(result.tight.truncated).toBe(true);
  // The SessionStart sidecar is its own file: it carries the current rows newest first, drops the over-long rule whole — the same rule
  // amem_brief applies — and a preference never takes a row of the curated section beside it.
  expect(result.sidecar.kinds).toEqual(["preference", "preference"]);
  expect(result.sidecar.partial).toEqual([false, false]);
  expect(result.sidecar.binding).toBe("string");
  expect(result.sidecar.curatedRows).toBe(0);
  // The hook brief emits both whole rules from that sidecar.
  expect(result.native.kinds).toEqual(["preference", "preference"]);
  // A person-recorded floor above this reader refuses the prebuilt slot rather than serving rows from it.
  expect(result.aboveFloor.kinds).toEqual([]);
  expect(result.aboveFloor.coverage.curated).not.toBe("complete");
});
