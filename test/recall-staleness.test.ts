import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRecallStalenessProbe } from "../src/memory/recall-staleness.ts";
import { createStandalonePolicy } from "../src/memory/policy.ts";
const dirs: string[] = []; afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const root = () => { const dir = mkdtempSync(join(tmpdir(), "amem-path-stale-")); dirs.push(dir); return dir; };
const at = "2026-10-20T00:00:00.000Z", time = Date.parse(at);
const stat = (mtimeMs = time, directory = false, symbolic = false) => ({ mtimeMs, isDirectory: () => directory, isSymbolicLink: () => symbolic });
test("only changed-after-note or missing paths produce advisory stale hints", () => {
  const cwd = root(), calls: string[] = [], probe = createRecallStalenessProbe({ cwd, probe: path => { calls.push(path); if (path.endsWith("gone.ts")) throw Object.assign(Error(), { code: "ENOENT" }); return stat(path.endsWith("/changed.ts") ? time + 1 : time); } });
  expect(probe({ at, about: ["path:unchanged.ts"] })).toBe(false); expect(probe({ at, about: ["symbol:parse@changed.ts"] })).toBe(true); expect(probe({ at, about: ["path:gone.ts"] })).toBe(true);
  expect(probe({ at, about: ["issue:o/r#1"] })).toBeUndefined(); expect(calls).toHaveLength(3);
});
test("literal, folded and host-glob/private guards run before filesystem access", () => {
  let reads = 0; const probe = createRecallStalenessProbe({ cwd: root(), deny: ["private"], policy: () => createStandalonePolicy({ denyPaths: ["staff"] }), allowedPath: path => !path.startsWith("hidden/"), probe: () => { reads++; return stat(time + 1); } });
  for (const path of [".env", "PRIVATE/secret.ts", "staff/person.ts", "hidden/a.ts", "../out.ts", "/absolute.ts"]) expect(probe({ at, about: [`path:${path}`] })).toBeUndefined(); expect(reads).toBe(0);
});
test("symlink ancestors are never followed and permission/unknown states never assert staleness", () => {
  const calls: string[] = [], probe = createRecallStalenessProbe({ cwd: root(), probe: path => { calls.push(path); return stat(time + 1, true, true); } });
  expect(probe({ at, about: ["path:link/child.ts"] })).toBeUndefined(); expect(calls).toHaveLength(1);
  const denied = createRecallStalenessProbe({ cwd: root(), probe: () => { throw Object.assign(Error(), { code: "EACCES" }); } }); expect(denied({ at, about: ["path:public.ts"] })).toBeUndefined();
});
test("shared call budget and cache are bounded; policy tightening suppresses cached evidence", () => {
  let reads = 0, denyAncestor = false; const probe = createRecallStalenessProbe({ cwd: root(), maxProbes: 2, allowedPath: path => !(denyAncestor && path === "src"), probe: path => { reads++; return stat(time + 1, path.endsWith("src")); } });
  expect(probe({ at, about: ["path:src/a.ts"] })).toBe(true); expect(reads).toBe(2); expect(probe({ at, about: ["path:b.ts"] })).toBeUndefined();
  denyAncestor = true; expect(probe({ at, about: ["path:src/a.ts"] })).toBeUndefined(); expect(reads).toBe(2);
  const invalid = createRecallStalenessProbe({ cwd: root(), maxProbes: NaN, probe: () => { reads++; return stat(); } }); expect(invalid({ at, about: ["path:a.ts"] })).toBeUndefined(); expect(reads).toBe(2);
});
