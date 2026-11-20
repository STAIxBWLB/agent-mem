import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { memoryHome } from "../src/memory/home.ts";

test("test preload refuses the real default memory home", () => {
  expect(() => memoryHome({ AMEM_HOME: join(homedir(), ".agenthub", "memory") })).toThrow("test refused the real default memory home");
  expect(memoryHome()).not.toBe(join(homedir(), ".agenthub", "memory"));
});
