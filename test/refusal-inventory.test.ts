import { expect, test } from "bun:test";
import { baselineGrowth, checkRefusals, collectRefusals } from "../scripts/refusal-inventory.ts";

const file = "src/example.ts";
const findings = (text: string) => checkRefusals(collectRefusals(file, text), []);

test("unnamed refusals require an exact baseline entry or a valid source marker", () => {
  const text = 'throw Error("look at the recorded evidence");';
  const rows = collectRefusals(file, text);
  expect(findings(text)).toMatchObject([{ reason: "missing an amem command or refusal-by-design marker" }]);
  expect(checkRefusals(rows, [{ file, message: "look at the recorded evidence" }])).toEqual([]);
  expect(findings('// refusal-by-design: world-action the remote must be reachable.\n' + text)).toEqual([]);
  expect(findings('// refusal-by-design: arbitrary anything\n' + text)).toHaveLength(1);
  expect(findings('throw Error(/* refusal-by-design: human-authority */ "needs an operator");')).toHaveLength(1);
});

test("unknown commands and flags are rejected even when marked or grandfathered", () => {
  const text = 'throw new CommandUsageError(/* refusal-by-design: human-authority approval required. */ "Run amem formats rasie");';
  expect(checkRefusals(collectRefusals(file, text), [{ file, message: "Run amem formats rasie" }]).map(f => f.reason))
    .toContain("unknown command amem formats rasie");
  expect(findings('throw Error("amem typod");')[0]?.reason).toBe("unknown command amem typod");
  expect(findings('throw Error("Try amem eval audit sample --seed <s> --old-flag");')[0]?.reason)
    .toBe("unknown flag --old-flag for amem eval audit sample");
});

test("templates, separate conditional outcomes, quoted paths, and alternative commands preserve their static names", () => {
  const text = 'throw Error(ok ? `Run amem formats raise ${surface} ${floor} --confirm` : "Use amem migrate --sync-placement --checkpoint --confirm --plan \'a b.json\' | amem eval audit sample --seed <seed>");';
  expect(findings(text)).toEqual([]);
  expect(findings('throw Error(ok ? "Run amem sync" : "Run amem sync --typo");')[0]?.reason).toBe("unknown flag --typo for amem sync");
  expect(findings(`throw Error('Run amem note add "quoted text" --typo');`)[0]?.reason).toBe("unknown flag --typo for amem note add");
  expect(findings('throw Error("an older amem version needs a newer runtime");')[0]?.reason).toMatch(/^missing/);
});

test("unused baseline entries fail, and checked-in exceptions can only shrink", () => {
  const old = { file, message: "old refusal" }, added = { file, message: "new refusal" };
  expect(checkRefusals([], [old])).toMatchObject([{ reason: "unused baseline entry" }]);
  expect(baselineGrowth([], [old])).toEqual([]);
  expect(baselineGrowth([old, added], [old])).toMatchObject([{ message: added.message, reason: expect.stringContaining("baseline grew") }]);
});
