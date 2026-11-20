import { afterEach, spyOn } from "bun:test";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import * as homes from "../src/memory/home.ts";
import { canonicalPath } from "../src/memory/platform.ts";

// Preloaded by bunfig.toml: inherited live homes are never used by the test process or its children.
const realDefault = canonicalPath(join(homedir(), ".agenthub", "memory"));
const resolve = homes.resolveMemoryHome, base = homes.memoryBase;
let refused = false;
afterEach(() => { if (refused) { refused = false; throw new Error("test resolved the real default memory home"); } });
const guard = (home: string) => {
  if (home === realDefault) { refused = true; throw new Error("test refused the real default memory home"); }
  return home;
};
spyOn(homes, "memoryHome").mockImplementation((env = process.env) => guard(resolve(env).home));
spyOn(homes, "resolveMemoryHome").mockImplementation((env = process.env) => { const result = resolve(env); guard(result.home); return result; });
spyOn(homes, "memoryBase").mockImplementation((home) => guard(base(home)));
delete process.env.AMEM_HOME;
process.env.AGENTHUB_HOME = mkdtempSync(join(tmpdir(), "amem-test-home-"));
