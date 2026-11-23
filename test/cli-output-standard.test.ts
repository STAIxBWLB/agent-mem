import { describe, expect, test } from "bun:test";
import { asciiMarkers, markerCell, paint, resolveColor, ROLE_SGR, SGR_RESET } from "@staix/cli-output";
import { parseCommand } from "../src/commands-table.ts";
import { formatCliError } from "../src/cli.ts";

describe("CLI output standard primitives", () => {
  test("color precedence and independent stream decisions", () => {
    expect(resolveColor("always", { isTTY: false, NO_COLOR: "1" }, "amem")).toBe(true);
    expect(resolveColor("never", { isTTY: true, FORCE_COLOR: "1" }, "amem")).toBe(false);
    expect(resolveColor("auto", { isTTY: true, NO_COLOR: "", FORCE_COLOR: "1" }, "amem")).toBe(true);
    expect(resolveColor("auto", { isTTY: true, NO_COLOR: "1", FORCE_COLOR: "1" }, "amem")).toBe(false);
    expect(resolveColor("auto", { isTTY: false, FORCE_COLOR: "0", CLICOLOR_FORCE: "1" }, "amem")).toBe(true);
    expect(resolveColor("auto", { isTTY: true, CLICOLOR: "0" }, "amem")).toBe(false);
    expect(resolveColor("auto", { isTTY: true, TERM: "dumb" }, "amem")).toBe(false);
    expect(resolveColor("auto", { isTTY: false }, "amem")).toBe(false);
    expect(resolveColor("bad", { isTTY: true }, "amem")).toBeInstanceOf(Error);
  });
  test("roles and locale markers", () => {
    expect(paint([{ role: "success", text: "ready" }], true)).toBe(`${ROLE_SGR.success}ready${SGR_RESET}`);
    expect(paint([{ role: "value", text: "ready" }], true)).toBe("ready");
    expect(paint([{ role: "error", text: "failed" }], false)).toBe("failed");
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
    expect(child.stderr.toString()).toContain("Usage: amem status [options]\nRun 'amem help status' for details.");
  });
  test("ordinary error text uses package terminal sanitization", () => {
    expect(formatCliError(new Error(`failed ${ROLE_SGR.error}red${SGR_RESET}`))).toBe("amem: failed red");
    expect(formatCliError(new Error("failure"), true)).toBe("amem: failure\nUsage: amem <command> [options]\nRun 'amem help' for details.");
  });
  test("TTY errors retain the colored two-cell marker and usage bytes", () => {
    const script = `import { main } from "./src/cli.ts"; Object.defineProperty(process.stderr, "isTTY", { value: true }); console.error = value => process.stderr.write(String(value) + ${JSON.stringify("\n")}); await main(["status", "--not-a-real-option"]);`;
    const message = formatCliError(new Error("unknown option --not-a-real-option"), true, ["status", "--not-a-real-option"]);
    for (const color of [false, true]) {
      const child = Bun.spawnSync([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe", env: { ...process.env, LC_ALL: "C", NO_COLOR: color ? "" : "1", FORCE_COLOR: color ? "1" : "0" } });
      expect(child.exitCode).toBe(2);
      expect(child.stderr.toString()).toBe(`${color ? `${ROLE_SGR.error}x ${SGR_RESET}` : "x "} ${message}\n`);
    }
  });
});
