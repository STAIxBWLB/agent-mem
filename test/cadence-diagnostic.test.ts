import { expect, test } from "bun:test";
import { collectCadenceCallDiagnostic, withCadenceFailureDiagnostics, type CadenceFailureDiagnostic } from "./fakes/cadence-diagnostic.ts";

const input = { call: 12, command: "sync", ifDue: true, force: true, elapsedMs: 30_100, exitCode: 0,
  stdout: JSON.stringify({ ok: false, error: "deadline", ignored: "not diagnostic data" }), stderr: "" };
const phase = (stage: string, fields = {}) => JSON.stringify({ diagnostic: "cadence-child-phase", stage, elapsedMs: 30_000, ...fields });

test("cadence diagnostic retains phase clocks and the actual deadline stop", () => {
  const row = collectCadenceCallDiagnostic({ ...input, stderr: ["unstructured stderr", phase("stop-created", { deadlineMs: 30_000 }),
    phase("transport:publish"), phase("stop-fired", { cause: "deadline" }),
    phase("cli-finished", { stops: [{ deadlineMs: 30_000, cause: "deadline", aborted: true }] })].join("\n") });
  expect(row.outcome).toEqual({ ok: false, skipped: null, error: "deadline", placementPublication: null });
  expect(row.phases.map(p => p.stage)).toEqual(["stop-created", "transport:publish", "stop-fired", "cli-finished"]);
  expect(row.observedDeadlinesMs).toEqual([30_000]);
  expect(row.stops).toEqual([{ deadlineMs: 30_000, cause: "deadline", aborted: true }]);
  expect(row.stopStateComplete).toBe(true);
});

test("an interrupted child leaves deadline state unknown rather than reporting no abort", () => {
  const row = collectCadenceCallDiagnostic({ ...input, signalCode: "SIGTERM", stdout: "", stderr: phase("stop-created", { deadlineMs: 30_000 }) });
  expect(row.outcome).toEqual({ json: false });
  expect(row.signalCode).toBe("SIGTERM");
  expect(row.observedDeadlinesMs).toEqual([30_000]);
  expect(row.stops).toBeNull();
  expect(row.stopStateComplete).toBe(false);
});

test("passing tests stay silent even when an expected CLI refusal was collected", async () => {
  const emitted: CadenceFailureDiagnostic[] = [];
  const calls = [collectCadenceCallDiagnostic({ ...input, exitCode: 1 })];
  expect(await withCadenceFailureDiagnostics(calls, () => "passed", row => emitted.push(row))).toBe("passed");
  expect(emitted).toEqual([]);
});

test("a failed assertion emits all calls once and rethrows the original error", async () => {
  const emitted: CadenceFailureDiagnostic[] = [], original = new Error("original assertion");
  const calls = [collectCadenceCallDiagnostic(input)];
  try {
    await withCadenceFailureDiagnostics(calls, () => { throw original; }, row => emitted.push(row));
    throw new Error("expected failure was swallowed");
  } catch (error) { expect(error).toBe(original); }
  expect(emitted).toEqual([{ diagnostic: "cadence-test-failure", lastCall: 12, calls }]);
});

test("a broken diagnostic sink cannot mask the assertion", async () => {
  const original = new Error("original assertion");
  try {
    await withCadenceFailureDiagnostics([], () => { throw original; }, () => { throw new Error("broken sink"); });
    throw new Error("expected failure was swallowed");
  } catch (error) { expect(error).toBe(original); }
});
