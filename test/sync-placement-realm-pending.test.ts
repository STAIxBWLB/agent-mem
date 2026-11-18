import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pendingRealmInventory } from "../src/memory/sync-placement-realm-pending.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function home() { const dir = mkdtempSync(join(tmpdir(), "amem-realm-pending-")); chmodSync(dir, 0o700); dirs.push(dir); return dir; }

test("#448: pending admission identifies its target without trusting torn content", () => {
  const dir = home(), key = "a".repeat(64), name = `placement-realm-intent-${key}.json`;
  expect(pendingRealmInventory(dir)).toEqual({ hashes: [], unknown: false });
  writeFileSync(join(dir, name), "{torn", { mode: 0o600 });
  expect(pendingRealmInventory(dir)).toEqual({ hashes: [key], unknown: false });
  writeFileSync(join(dir, `${name}.pending-${"b".repeat(64)}`), "partial", { mode: 0o600 });
  expect(pendingRealmInventory(dir)).toEqual({ hashes: [key], unknown: false });
});

test("#448: unsafe or unidentifiable pending evidence never authorizes another realm", () => {
  const dir = home(), key = "a".repeat(64), file = join(dir, `placement-realm-intent-${key}.json`);
  symlinkSync("/missing", file); expect(pendingRealmInventory(dir)).toEqual({ hashes: [key], unknown: true });
  rmSync(file); writeFileSync(join(dir, "placement-realm-intent-unknown"), "", { mode: 0o600 });
  expect(pendingRealmInventory(dir)).toEqual({ hashes: [], unknown: true });
});
