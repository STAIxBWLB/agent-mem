import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hookFixture } from "./fakes/hooks-fixture.ts";
import { hookTimeoutProbe } from "./fakes/hooks-timeout-probe.ts";

for (const [event, phase, branch] of [
  ["SessionStart", "loader", "pre-admission"],
  ["PreToolUse", "command", "spawned-not-entered"],
] as const) test(`real ${event} ${phase} timeout retains every strict outcome with a mandatory cleanup control`, async () => {
  const f = hookFixture(), run = f.run;
  // Delay only the actual native invocation. Its mandatory control uses its own
  // fixture and must reach every child/entry under the published bin bootstrap and existing host seam.
  f.run = (name, payload, extra = {}) => {
    const preload = extra.BUN_OPTIONS!.slice("--preload=".length), code = readFileSync(preload, "utf8");
    const anchor = phase === "loader" ? " const source=readFileSync(path,'utf8'),guard=" : "const sleeper='sleep 30 &";
    expect(code.split(anchor)).toHaveLength(2);
    writeFileSync(preload, code.replace(anchor, phase === "loader" ? " Bun.sleepSync(200);" + anchor : "const sleeper='/bin/sleep 0.3; sleep 30 &"));
    return run(name, payload, extra);
  };
  try {
    const result = await hookTimeoutProbe(f, event, false);
    if (phase === "command") {
      // The command delay is only reached after admission. The real deadline can expire earlier; the probe proves
      // the corresponding guard or child lifecycle before returning either branch.
      expect(["pre-admission", "spawned-not-entered"]).toContain(result.branch);
      expect(result.ownedChildren).toBe(result.branch === "pre-admission" ? 0 : 2);
    } else {
      expect(result.branch).toBe(branch);
      expect(result.ownedChildren).toBe(0);
    }
    expect(result.remainingProcesses).toBe(0);
    expect(result.branchEvidenceOwners).toBe(result.ownedChildren);
    expect(result.pending).toMatch(/^hook-/);
    expect(result.rssMB).toBeGreaterThan(0);
  } finally { f.close(); }
}, 10000);

// A separate host-seam fixture guarantees time for admission, then delays entry beyond that deadline. It keeps the
// native-deadline probe above intact and still requires its own successful cleanup control.
test("controlled PreToolUse timeout proves spawned-not-entered after admission", async () => {
  const f = hookFixture(), run = f.run;
  f.run = (name, payload, extra = {}) => {
    const preload = extra.BUN_OPTIONS!.slice("--preload=".length), code = readFileSync(preload, "utf8");
    const anchor = "const sleeper='sleep 30 &";
    expect(code.split(anchor)).toHaveLength(2);
    writeFileSync(preload, code.replace(anchor, "const sleeper='/bin/sleep 4; sleep 30 &"));
    return run(name, payload, extra);
  };
  try {
    const result = await hookTimeoutProbe(f, "PreToolUse", false, { run: 1, logicalRun: 1 }, 2000);
    expect(result.branch).toBe("spawned-not-entered");
    expect(result.ownedChildren).toBe(2);
    expect(result.remainingProcesses).toBe(0);
    expect(result.branchEvidenceOwners).toBe(result.ownedChildren);
    expect(result.pending).toMatch(/^hook-/);
    expect(result.rssMB).toBeGreaterThan(0);
  } finally { f.close(); }
}, 10000);

test("incomplete native receipt emits PID and timing evidence through the budget probe", async () => {
  const f = hookFixture(), run = f.run, output: string[] = [], originalLog = console.log;
  f.run = (name, payload, extra = {}) => {
    const result = run(name, payload, extra), receipt = join(f.root, "owned-native.pid");
    const pids = readFileSync(receipt, "utf8").trim().split("\n");
    expect(pids).toHaveLength(2);
    // Model the incomplete shared receipt after the fixture wrote its independent child markers.
    writeFileSync(receipt, pids[0]! + "\n");
    return result;
  };
  console.log = (...values: unknown[]) => { output.push(values.map(String).join(" ")); };
  try {
    const outcome = await hookTimeoutProbe(f, "PreToolUse", false, { run: 1, logicalRun: 1 }, 2000).then(value => JSON.stringify(value), error => String(error));
    expect(outcome, output.join("\n")).toContain("invalid owned descendant receipt");
    const record = output.map(line => { try { return JSON.parse(line); } catch { return null; } })
      .find(row => row?.diagnostic === "timeout-descendant-refusal/v1");
    expect(record?.branch).toBe("admitted-blocked"); expect(record?.receipt.pids).toBe(1);
    expect(record?.childEvidence.missingPids).toHaveLength(1);
    expect(record?.childEvidence.owners).toHaveLength(2);
    expect(record?.childEvidence.children).toHaveLength(2);
    expect(record?.childEvidence.truncated).toBe(false);
  } finally { console.log = originalLog; f.close(); }
}, 15000);
