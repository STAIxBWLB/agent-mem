import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireMutation, assertMutationHandle, type MutationHandle } from "../src/memory/mutation.ts";
import { persistPublicPruneInput, preparePublicPruneInput, readPublicPruneInputSetChain, type PublicPruneBinding } from "../src/memory/public-prune-inputs.ts";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const done of cleanup.splice(0).reverse()) done(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "amem-mutation-handle-")); chmodSync(dir, 0o700);
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test("only a live module-issued handle authorizes its original directory", () => {
  const dir = fixture(), other = fixture(), handle = acquireMutation(dir)!; cleanup.push(handle);
  expect(() => assertMutationHandle(handle, dir)).not.toThrow();
  for (const fake of [(() => {}) as unknown as MutationHandle, Object.assign(() => {}, { active: true, dir }) as unknown as MutationHandle]) {
    expect(() => assertMutationHandle(fake, dir)).toThrow();
  }
  expect(() => assertMutationHandle(handle, other)).toThrow();
  handle(); expect(() => assertMutationHandle(handle, dir)).toThrow(); expect(() => handle()).not.toThrow();
});
test("renamed or replaced directory cannot inherit an active handle", () => {
  const root = fixture(), dir = join(root, "data"), moved = join(root, "moved"); mkdirSync(dir, { mode: 0o700 });
  const handle = acquireMutation(dir)!; cleanup.push(handle); renameSync(dir, moved); mkdirSync(dir, { mode: 0o700 });
  expect(() => assertMutationHandle(handle, dir)).toThrow(); expect(() => assertMutationHandle(handle, moved)).toThrow();
});
test("Layer 2 borrows its genuine fence and leaves release ownership with the caller", () => {
  const dir = fixture(), handle = acquireMutation(dir)!; cleanup.push(handle);
  const binding: PublicPruneBinding = { realm: { scope: "user" }, receivingGeneration: "a".repeat(32), selectorRevision: "b".repeat(64), inputSetHash: null };
  const plan = () => preparePublicPruneInput({ dir, binding, current: () => binding, input: null });
  expect(() => persistPublicPruneInput(plan(), { mutation: (() => {}) as unknown as MutationHandle })).toThrow();
  const result = persistPublicPruneInput(plan(), { mutation: handle });
  expect(() => assertMutationHandle(handle, dir)).not.toThrow();
  expect(readPublicPruneInputSetChain({ dir, receivingGeneration: binding.receivingGeneration, inputSetHash: result.inputSetHash })).toEqual({ commitments: [result.inputSetHash], inputs: [] });
  handle(); expect(() => persistPublicPruneInput(plan(), { mutation: handle })).toThrow();
});
