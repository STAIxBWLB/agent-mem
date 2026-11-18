import { expect, test } from "bun:test";
import { PlacementRealmRefusal } from "../src/memory/shard.ts";

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
