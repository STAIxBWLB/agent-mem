import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalJSON, hashJSON } from "../src/memory/generation.ts";
import { assertNoPublicPruneIntent, PUBLIC_PRUNE_INTENT, publicPruneViewHash, readPublicPruneView, validatePublicPruneView, type PublicPruneViewV1 } from "../src/memory/public-prune-view.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const done of cleanup.splice(0).reverse()) done(); });
const sample = (): PublicPruneViewV1 => ({ schema: "agent-mem.public-prune-view/v1", receivingGeneration: "a".repeat(32),
  realms: { "project:github.com/example/project": "b".repeat(64), user: "c".repeat(64) } });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "amem-public-prune-view-")); chmodSync(home, 0o700);
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const folder = join(home, "public-prune-input-sets"); mkdirSync(folder, { mode: 0o700 });
  const view = sample(), hash = publicPruneViewHash(view), file = join(folder, hash + ".json");
  writeFileSync(file, canonicalJSON(view) + "\n", { mode: 0o600 });
  return { home, folder, file, view, hash, read: () => readPublicPruneView(home, hash, view.receivingGeneration) };
}

test("root view validation preserves original realm keys, sorts keys and hashes independently of insertion order", () => {
  const original = sample(), reversed = { ...original, realms: { user: original.realms.user!, "project:github.com/example/project": original.realms["project:github.com/example/project"]! } };
  expect(validatePublicPruneView(original)).toEqual(original);
  expect(Object.keys(validatePublicPruneView(reversed).realms)).toEqual(["project:github.com/example/project", "user"]);
  expect(publicPruneViewHash(original)).toBe(publicPruneViewHash(reversed)); expect(publicPruneViewHash(original)).toBe(hashJSON(original));
  const unicode = { ...original, realms: { "project:한글/프로젝트": "d".repeat(64) } };
  expect(validatePublicPruneView(unicode)).toEqual(unicode);
  const empty = { ...original, realms: {} }; expect(validatePublicPruneView(empty)).toEqual(empty);
  const copy = validatePublicPruneView(original); copy.realms.user = "f".repeat(64); expect(original.realms.user).toBe("c".repeat(64));
});

test("root view rejects unknown schema/fields, malformed generation, realm aliases and nonexact hashes", () => {
  for (const input of [null, [], { ...sample(), extra: true }, { ...sample(), schema: "agent-mem.public-prune-view/v2" },
    { ...sample(), receivingGeneration: "A".repeat(32) }, { ...sample(), receivingGeneration: "a".repeat(32) + "\n" },
    { ...sample(), realms: [] }, { ...sample(), realms: { "project:": "a".repeat(64) } },
    { ...sample(), realms: { "project: trailing ": "a".repeat(64) } }, { ...sample(), realms: { "project:bad\nkey": "a".repeat(64) } },
    { ...sample(), realms: { "project": "a".repeat(64) } }, { ...sample(), realms: { "user:other": "a".repeat(64) } },
    { ...sample(), realms: { user: "a".repeat(64) + "\n" } }, { ...sample(), realms: { user: true } },
    { ...sample(), realms: { user: "A".repeat(64) } }]) expect(() => validatePublicPruneView(input)).toThrow("public prune view unavailable");
  const symbols = { ...sample(), [Symbol("unknown")]: true }; expect(() => validatePublicPruneView(symbols)).toThrow("public prune view unavailable");
});

test("root view enforces the complete UTF8 byte budget without truncating realm keys", () => {
  const over = { ...sample(), realms: { ["project:" + "한".repeat(22_000)]: "a".repeat(64) } };
  expect(() => validatePublicPruneView(over)).toThrow("public prune view unavailable");
  const many = { ...sample(), realms: Object.fromEntries(Array.from({ length: 1025 }, (_, n) => [`project:${n}`, "a".repeat(64)])) };
  expect(() => validatePublicPruneView(many)).toThrow("public prune view unavailable");
});

test("root view reads full private canonical content by hash and rejects a receiving-generation mismatch", () => {
  const f = fixture(), before = readFileSync(f.file);
  expect(f.read()).toEqual(f.view); expect(lstatSync(f.file).nlink).toBe(1);
  writeFileSync(f.file, canonicalJSON(f.view)); expect(f.read()).toEqual(f.view);
  expect(() => readPublicPruneView(f.home, f.hash, "f".repeat(32))).toThrow("public prune view unavailable");
  expect(() => readPublicPruneView(f.home, "../escape", f.view.receivingGeneration)).toThrow("public prune view unavailable");
  expect(readdirSync(f.folder)).toEqual([f.hash + ".json"]); expect(before.toString()).toBe(canonicalJSON(f.view) + "\n");
});

for (const damage of ["missing", "altered", "noncanonical", "duplicate key", "invalid UTF8", "oversized", "empty"] as const) {
  test(`root view ${damage} fails closed without repair or fallback`, () => {
    const f = fixture();
    if (damage === "missing") unlinkSync(f.file);
    if (damage === "altered") writeFileSync(f.file, canonicalJSON({ ...f.view, realms: {} }) + "\n");
    if (damage === "noncanonical") writeFileSync(f.file, JSON.stringify(f.view, null, 2));
    if (damage === "duplicate key") writeFileSync(f.file, canonicalJSON(f.view).replace('"realms":', '"realms":{},"realms":'));
    if (damage === "invalid UTF8") writeFileSync(f.file, Buffer.from([255]));
    if (damage === "oversized") writeFileSync(f.file, Buffer.alloc(65_537, 65));
    if (damage === "empty") writeFileSync(f.file, "");
    expect(() => f.read()).toThrow("public prune view unavailable");
    expect(existsSync(f.file)).toBe(damage !== "missing");
  });
}

for (const damage of ["symlink", "hardlink", "mode", "directory"] as const) test(`root view ${damage} is refused`, () => {
  const f = fixture(), outside = join(f.home, "outside");
  if (damage === "mode") chmodSync(f.file, 0o644);
  else {
    const bytes = readFileSync(f.file); unlinkSync(f.file); writeFileSync(outside, bytes, { mode: 0o600 });
    if (damage === "symlink") symlinkSync(outside, f.file);
    if (damage === "hardlink") linkSync(outside, f.file);
    if (damage === "directory") mkdirSync(f.file, { mode: 0o700 });
  }
  expect(() => f.read()).toThrow("public prune view unavailable");
});

test("root view rejects an archive directory symlink and public home/directory permissions", () => {
  const f = fixture(), moved = join(f.home, "moved"); mkdirSync(moved, { mode: 0o700 });
  writeFileSync(join(moved, f.hash + ".json"), readFileSync(f.file), { mode: 0o600 });
  rmSync(f.folder, { recursive: true }); symlinkSync(moved, f.folder);
  expect(() => f.read()).toThrow("public prune view unavailable");
  for (const level of ["home", "folder"] as const) { const g = fixture(); chmodSync(g[level], 0o755); expect(() => g.read()).toThrow("public prune view unavailable"); }
  const g = fixture(), alias = join(g.home, "home-alias"); symlinkSync(g.home, alias);
  expect(() => readPublicPruneView(alias, g.hash, g.view.receivingGeneration)).toThrow("public prune view unavailable");
});

for (const kind of ["valid", "malformed", "directory", "dangling symlink"] as const) test(`any ${kind} activation intent blocks reads and remains untouched`, () => {
  const f = fixture(), intent = join(f.home, PUBLIC_PRUNE_INTENT);
  if (kind === "directory") mkdirSync(intent, { mode: 0o700 });
  else if (kind === "dangling symlink") symlinkSync(join(f.home, "missing"), intent);
  else writeFileSync(intent, kind === "valid" ? canonicalJSON({ phase: "prepared" }) : "incomplete PRIVATE-INTENT-CANARY", { mode: 0o600 });
  const before = lstatSync(intent);
  expect(() => assertNoPublicPruneIntent(f.home)).toThrow("public prune view unavailable");
  expect(() => f.read()).toThrow("public prune view unavailable"); expect(lstatSync(intent).ino).toBe(before.ino);
});

test("absent activation intent permits a new missing home without creating storage", () => {
  const f = fixture(), missing = join(f.home, "not-yet-created");
  expect(() => assertNoPublicPruneIntent(f.home)).not.toThrow(); expect(() => assertNoPublicPruneIntent(missing)).not.toThrow();
  expect(existsSync(missing)).toBe(false);
});
