import { expect, test } from "bun:test";
import { createRemoteAdoption, REMOTE_ADOPTION_SCHEMA, validateRemoteAdoption } from "../src/memory/sync-placement-remote-adoption-format.ts";

const body = () => ({ schema: REMOTE_ADOPTION_SCHEMA, homeHash: "1".repeat(64), epochHash: "2".repeat(64), generation: "3".repeat(32), keyHash: "4".repeat(64),
  remoteHash: "5".repeat(64), remoteHead: "6".repeat(40), policyHash: "7".repeat(64), aliasesHash: "8".repeat(64), omitted: 2,
  packs: [{ name: `sync-${"9".repeat(64)}.jsonl`, bytes: 25 }] });

test("remote adoption evidence binds all reviewed hashes without names or row bodies", () => {
  const value = createRemoteAdoption(body()); expect(validateRemoteAdoption(value)).toEqual(value);
  expect(() => validateRemoteAdoption({ ...value, remoteHead: "a".repeat(40) })).toThrow();
  expect(() => validateRemoteAdoption({ ...value, project: "private" })).toThrow();
  expect(() => createRemoteAdoption({ ...body(), packs: [{ name: "../outside", bytes: 1 }] })).toThrow();
  expect(() => createRemoteAdoption({ ...body(), packs: [...body().packs, ...body().packs] })).toThrow();
  expect(() => createRemoteAdoption({ ...body(), omitted: -1 })).toThrow();
});
