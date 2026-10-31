import { test, expect } from "bun:test";
import { hookFixture } from "./fakes/hooks-fixture.ts";

function hasSystemMessage(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Object.hasOwn(value, "systemMessage")) return true;
  return Object.values(value).some(hasSystemMessage);
}

test("normal SessionStart hook emits only additionalContext and stays silent on stderr", async () => {
  const f = hookFixture();
  try {
    await f.seed();
    const result = f.runFunctional("SessionStart");
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    const output = JSON.parse(result.stdout.toString());
    expect(typeof output.hookSpecificOutput?.additionalContext).toBe("string");
    expect(output.hookSpecificOutput.additionalContext.length).toBeGreaterThan(0);
    expect(hasSystemMessage(output)).toBe(false);
  } finally { f.close(); }
});
