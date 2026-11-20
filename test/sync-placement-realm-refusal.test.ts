import { expect, test } from "bun:test";
import { PlacementRealmRefusal, type PlacementRealmGap } from "../src/memory/shard.ts";

const keyHash = "a".repeat(64);

test("#448: a realm refusal names its scope, key hash, origin and the admission command", () => {
  const error = new PlacementRealmRefusal("project", keyHash, "cwd binding");
  expect(error.scope).toBe("project"); expect(error.keyHash).toBe(keyHash); expect(error.origin).toBe("cwd binding");
  expect(error.message).toContain("outside the activated inventory");
  expect(error.message).toContain(`scope=project keyHash=${keyHash}`);
  expect(error.message).toContain("origin=cwd binding");
  expect(error.message).toContain("amem migrate --sync-placement --admit <project> --dry-run, then --apply");
});

test("#448: the user realm refuses without a key hash and names activation, not an admission it cannot have", () => {
  const error = new PlacementRealmRefusal("user", undefined, "local binding");
  expect(error.message).toContain("scope=user"); expect(error.message).not.toContain("keyHash=");
  expect(error.message).toContain("the user realm is fixed at activation; review it with amem migrate --sync-placement --dry-run");
  expect(error.message).not.toContain("--admit");
});

// #525: each class carries the next step that class actually needs, and nothing else identifies the realm.
const ADMIT = "admit it with amem migrate --sync-placement --admit <project> --dry-run, then --apply";
const REMEDIES: [PlacementRealmGap, string, string[]][] = [
  ["local-key", "amem sync --remote <url>", [ADMIT, "amem project archive <project>"]],
  ["capture-only", "capture stays readable", [ADMIT]],
  ["no-memory", "no captured rows and no curated notes", [ADMIT, "amem project archive <project>"]],
  ["curated-unadmitted", "curated notes that are not part of the activated inventory", [ADMIT]],
  // Neither state could be proved, so the sentence asks the person to look instead of naming a command that would guess.
  ["unverified", "inspect the home before changing anything", []],
];

test("#525: every realm class states its own next step, after the same bounded identifiers", () => {
  for (const [gap, remedy, extra] of REMEDIES) {
    const error = new PlacementRealmRefusal("project", keyHash, "remote", gap);
    expect(error.gap).toBe(gap);
    expect(error.message.startsWith(`sync placement realm is outside the activated inventory: scope=project keyHash=${keyHash}; origin=remote; class=${gap};`)).toBe(true);
    expect(error.message).toContain(remedy);
    for (const fragment of extra) expect(error.message).toContain(fragment);
    // No path or project name: the key hash is the only identifier a message may carry.
    expect(error.message).not.toContain("/projects/");
    expect(error.message).not.toContain(keyHash.slice(0, 8) + "/");
  }
  expect(new Set(REMEDIES.map(([gap]) => gap)).size).toBe(5);
});

test("#525: only a class that was proved recommends admission, and an unproved one asks for inspection", () => {
  const unverified = new PlacementRealmRefusal("project", keyHash, "remote", "unverified").message;
  expect(unverified).not.toContain(ADMIT);
  expect(unverified).not.toContain("amem project archive");
  // The classes are distinct sentences, never one generic admission hint relabelled.
  const messages = REMEDIES.map(([gap]) => new PlacementRealmRefusal("project", keyHash, "remote", gap).message);
  expect(new Set(messages).size).toBe(5);
});

test("#525: a local-key realm separates admission from the per-invocation remote opt-in, and archive stays an alternative", () => {
  const message = new PlacementRealmRefusal("project", keyHash, "remote", "local-key").message;
  expect(message.indexOf("admit it with")).toBeLessThan(message.indexOf("amem sync --remote <url>"));
  expect(message).toContain("amem project archive <project>");
  // The key itself is never echoed, so this message cannot be built by reusing the key-embedding local-key helper.
  expect(message).not.toContain("Local project");
});

test("#525: an unclassified project refusal keeps the plain admission sentence", () => {
  const error = new PlacementRealmRefusal("project", keyHash, "local binding");
  expect(error.gap).toBeUndefined();
  expect(error.message).not.toContain("class=");
  expect(error.message.endsWith("admit it with amem migrate --sync-placement --admit <project> --dry-run, then --apply")).toBe(true);
});

test("#525: a linked projects/ directory is never followed while deriving a class", async () => {
  const { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { ensureShardDescriptor, placementRealmGap } = await import("../src/memory/shard.ts");
  const root = mkdtempSync(join(tmpdir(), "amem-realm-link-")), base = join(root, "memory");
  try {
    mkdirSync(base, { recursive: true });
    const key = "https://github.com/acme/elsewhere.git";
    ensureShardDescriptor(base, key);
    const view = { kind: "inventory" as const, admitted: () => false, assertCurrent: () => {} };
    expect(placementRealmGap(base, key, view)).toBe("no-memory");
    renameSync(join(base, "projects"), join(root, "projects-elsewhere"));
    symlinkSync(join(root, "projects-elsewhere"), join(base, "projects"));
    expect(placementRealmGap(base, key, view)).toBe("unverified");
    // A shard directory that is a link to a directory holding a 0600 generation.json: never followed, never curated-unadmitted.
    rmSync(join(base, "projects")); renameSync(join(root, "projects-elsewhere"), join(base, "projects"));
    const { shardDir } = await import("../src/memory/shard.ts");
    const { cpSync, writeFileSync } = await import("node:fs");
    const outside = join(root, "outside-shard"); mkdirSync(outside);
    writeFileSync(join(outside, "generation.json"), "{}", { mode: 0o600 });
    cpSync(join(shardDir(base, key), "project.json"), join(outside, "project.json"));
    rmSync(shardDir(base, key), { recursive: true }); symlinkSync(outside, shardDir(base, key));
    expect(placementRealmGap(base, key, view)).toBe("unverified");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
