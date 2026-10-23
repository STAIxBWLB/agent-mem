import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureStore } from "../src/memory/capture.ts";
import { appendAlias, shardDir } from "../src/memory/shard.ts";
import { appendLifecycle, assertProjectActive, lifecyclePath, listLifecycle, projectState } from "../src/memory/lifecycle.ts";

// #15 T5 / D3: archive, unarchive and forget are append-only ops in the memory home. The latest op wins, forgotten is terminal, and nothing
// rewrites a line: the shards themselves are never touched by a lifecycle op.
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function home(): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), "amem-lifecycle-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, base: join(dir, "memory") };
}
function shard(dir: string, project: string): void {
  const store = new CaptureStore({ home: dir, project });
  store.append({ project, agent: "kimi", event: "PostToolUse", excerpt: "one row", at: "2026-10-16T00:00:00.000Z" });
  store.close();
}
const op = (base: string, kind: "archive" | "unarchive" | "forget", key: string) => appendLifecycle(base, { op: kind, key, actor: "person", machine: "m1" });

test("a project starts active, archive and unarchive toggle it, and the latest op wins", () => {
  const { dir, base } = home(); shard(dir, "github.com/owner/a");
  expect(projectState(base, "github.com/owner/a")).toBe("active");
  op(base, "archive", "github.com/owner/a");
  expect(projectState(base, "github.com/owner/a")).toBe("archived");
  op(base, "unarchive", "github.com/owner/a");
  expect(projectState(base, "github.com/owner/a")).toBe("active");
  expect(listLifecycle(base).map(row => row.op)).toEqual(["archive", "unarchive"]);
});

test("forgotten is terminal: nothing moves it back, and a later line in the file cannot either", () => {
  const { dir, base } = home(); shard(dir, "github.com/owner/a");
  op(base, "forget", "github.com/owner/a");
  expect(projectState(base, "github.com/owner/a")).toBe("forgotten");
  for (const kind of ["archive", "unarchive", "forget"] as const) expect(() => op(base, kind, "github.com/owner/a")).toThrow(/forgotten/);
  // a hand-appended line (another machine's racing append, a restore) is read but never revives it
  const line = JSON.stringify({ schema: "agent-hub.memory.shard/v1", op: "unarchive", at: "2026-10-20T00:00:00.000Z", machine: "m2", key: "github.com/owner/a", actor: "person" });
  appendFileSync(lifecyclePath(base), line + "\n");
  expect(projectState(base, "github.com/owner/a")).toBe("forgotten");
});

test("transitions are checked: archive needs active, unarchive needs archived, and an unknown shard is refused with nothing written", () => {
  const { dir, base } = home(); shard(dir, "github.com/owner/a");
  expect(() => op(base, "unarchive", "github.com/owner/a")).toThrow(/not archived/);
  op(base, "archive", "github.com/owner/a");
  expect(() => op(base, "archive", "github.com/owner/a")).toThrow(/already archived/);
  const before = readFileSync(lifecyclePath(base), "utf8");
  expect(() => op(base, "archive", "github.com/owner/unknown")).toThrow(/no project shard/);
  expect(readFileSync(lifecyclePath(base), "utf8")).toBe(before);
});

test("an op never rewrites a line: the file only grows, every earlier byte is unchanged", () => {
  const { dir, base } = home(); shard(dir, "github.com/owner/a");
  op(base, "archive", "github.com/owner/a");
  const first = readFileSync(lifecyclePath(base), "utf8");
  op(base, "unarchive", "github.com/owner/a"); op(base, "forget", "github.com/owner/a");
  const after = readFileSync(lifecyclePath(base), "utf8");
  expect(after.startsWith(first)).toBe(true);
  expect(after.split("\n").filter(Boolean)).toHaveLength(3);
  expect(statSync(lifecyclePath(base)).mode & 0o777).toBe(0o600);
});

test("one project only: another project's state, shard bytes and capture are untouched", () => {
  const { dir, base } = home(); shard(dir, "github.com/owner/a"); shard(dir, "github.com/owner/b");
  const bytes = readFileSync(join(shardDir(base, "github.com/owner/b"), "project.json"), "utf8");
  op(base, "forget", "github.com/owner/a");
  expect(projectState(base, "github.com/owner/b")).toBe("active");
  expect(readFileSync(join(shardDir(base, "github.com/owner/b"), "project.json"), "utf8")).toBe(bytes);
  expect(() => assertProjectActive(base, "github.com/owner/b")).not.toThrow();
  expect(() => assertProjectActive(base, "github.com/owner/a")).toThrow(/forgotten/);
});

test("an alias resolves to its canonical key: archiving the old key archives the one project, and the reply names it", () => {
  const { dir, base } = home(); shard(dir, "github.com/owner/a");
  appendAlias(base, { alias: "old-a", key: "github.com/owner/a", actor: "person", machine: "m1" });
  const written = op(base, "archive", "old-a");
  expect(written.key).toBe("github.com/owner/a");
  expect(projectState(base, "old-a")).toBe("archived"); expect(projectState(base, "github.com/owner/a")).toBe("archived");
});

test("a malformed, oversized or unknown line is skipped, never fatal, and no file means active", () => {
  const { dir, base } = home(); shard(dir, "github.com/owner/a");
  expect(projectState(base, "github.com/owner/a")).toBe("active");
  op(base, "archive", "github.com/owner/a");
  appendFileSync(lifecyclePath(base), "not json\n" + JSON.stringify({ op: "forget" }) + "\n" + JSON.stringify({ schema: "other/v9", op: "forget", key: "github.com/owner/a" }) + "\n");
  expect(projectState(base, "github.com/owner/a")).toBe("archived");
});

test("a writable capture store for an archived or forgotten project is refused, a read-only one is not, and gc may open it explicitly", () => {
  const { dir, base } = home(); shard(dir, "github.com/owner/a");
  op(base, "archive", "github.com/owner/a");
  expect(() => new CaptureStore({ home: dir, project: "github.com/owner/a" })).toThrow(/archived/);
  const ignoring = new CaptureStore({ home: dir, project: "github.com/owner/a", lifecycle: "ignore" });
  expect(ignoring.stats().rows).toBe(1); ignoring.close();
  op(base, "unarchive", "github.com/owner/a");
  const back = new CaptureStore({ home: dir, project: "github.com/owner/a" });
  back.append({ project: "github.com/owner/a", agent: "kimi", event: "PostToolUse", excerpt: "after unarchive", at: "2026-10-17T00:00:00.000Z" });
  expect(back.stats().rows).toBe(2); back.close();
});
