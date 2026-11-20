import { describe, expect, test } from "bun:test";
import { asciiMarkers, markerCell, paint, resolveColor, ROLE_SGR, SGR_RESET } from "../src/memory/style.ts";
import { parseCommand } from "../src/commands-table.ts";

describe("CLI output standard primitives", () => {
  test("color precedence and independent stream decisions", () => {
    expect(resolveColor("always", { isTTY: false, NO_COLOR: "1" })).toBe(true);
    expect(resolveColor("never", { isTTY: true, FORCE_COLOR: "1" })).toBe(false);
    expect(resolveColor("auto", { isTTY: true, NO_COLOR: "", FORCE_COLOR: "1" })).toBe(true);
    expect(resolveColor("auto", { isTTY: true, NO_COLOR: "1", FORCE_COLOR: "1" })).toBe(false);
    expect(resolveColor("auto", { isTTY: false, FORCE_COLOR: "0", CLICOLOR_FORCE: "1" })).toBe(true);
    expect(resolveColor("auto", { isTTY: true, CLICOLOR: "0" })).toBe(false);
    expect(resolveColor("auto", { isTTY: true, TERM: "dumb" })).toBe(false);
    expect(resolveColor("auto", { isTTY: false })).toBe(false);
    expect(resolveColor("bad", { isTTY: true })).toBeInstanceOf(Error);
  });
  test("roles and locale markers", () => {
    expect(paint("success", "ready", true)).toBe(`${ROLE_SGR.success}ready${SGR_RESET}`);
    expect(paint("value", "ready", true)).toBe("ready");
    expect(paint("error", "failed", false)).toBe("failed");
    expect(asciiMarkers({ LC_ALL: "C", LANG: "en_US.UTF-8" })).toBe(true);
    expect(asciiMarkers({ LANG: "en_US.UTF-8" })).toBe(false);
    expect(asciiMarkers({ LANG: "en_US.UTF-8" }, true)).toBe(true);
    expect(markerCell("ok", true)).toBe("ok");
    expect(markerCell("next", true)).toBe("->");
    expect(markerCell("ok", false)).toBe("✓ ");
  });
  test("output options are validated and excluded from downstream command arguments", () => {
    const parsed = parseCommand(["status", "--color=always", "--ascii"]);
    expect(parsed.options["--color"]).toBe("always");
    expect(parsed.options["--ascii"]).toBe(true);
    expect(parsed.rawArgs).toEqual(["status"]);
    expect(() => parseCommand(["status", "--color=invalid"])).toThrow();
  });
  test("invalid options are usage errors on stderr", () => {
    const child = Bun.spawnSync([process.execPath, "bin/amem.js", "status", "--not-a-real-option"], { stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode).toBe(2);
    expect(child.stdout.toString()).toBe("");
    expect(child.stderr.toString()).toContain("amem: unknown option --not-a-real-option");
    expect(child.stderr.toString()).toContain("Run 'amem --help' for details.");
  });
});
