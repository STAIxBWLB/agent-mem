import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CandidateStore } from "../src/memory/candidates.ts";
import { realPath } from "../src/memory/platform.ts";
import { MemoryStore } from "../src/memory/store.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
const project = "synthetic/path-regression";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amem-candidate-path-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const parent = join(root, "literal\\backslash"), actual = join(parent, "actual"), alias = join(parent, "alias");
  mkdirSync(actual, { recursive: true }); symlinkSync(actual, alias, "dir");
  const candidates = new CandidateStore({ home: actual }); cleanup.push(() => candidates.close());
  const id = candidates.put({ project, kind: "fail", approach: "synthetic path alias", symptom: "same store was refused", cause: "canonicalization fell back to lexical alias", evidenceRefs: ["test:candidate-path"], retryWhen: "realPath resolves both existing directories" }, "public");
  return { actual, alias, candidates, id };
}

test("candidate acceptance resolves one actual memory directory through a symlink under a literal backslash parent", () => {
  const f = fixture(), memory = new MemoryStore({ home: f.alias, screen: () => "promote" }); cleanup.push(() => memory.close());
  expect(memory.dir).not.toBe(f.candidates.dir);
  expect(realPath(memory.dir)).toBe(realPath(f.candidates.dir));
  const result = f.candidates.accept(f.id, { project, actor: "person", verdict: "public", store: memory, policy: () => true });
  expect(result.candidateId).toBe(f.id);
  expect(memory.get(result.noteId, project)).toMatchObject({ tier: "long", scope: "project", kind: "fail" });
  expect(f.candidates.get(f.id, project)?.status).toBe("accepted");
});

test("candidate acceptance still refuses a different actual memory directory beneath a backslash parent", () => {
  const f = fixture(), memory = new MemoryStore({ home: join(f.actual, "different"), screen: () => "promote" }); cleanup.push(() => memory.close());
  expect(realPath(memory.dir)).not.toBe(realPath(f.candidates.dir));
  expect(() => f.candidates.accept(f.id, { project, actor: "person", verdict: "public", store: memory, policy: () => true })).toThrow("requires its memory store");
  expect(memory.list({ project })).toEqual([]);
  expect(f.candidates.get(f.id, project)?.status).toBe("pending");
});
