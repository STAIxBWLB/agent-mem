import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT, Report, errorLine, markerCell, resolveColor, type MarkerName } from "@staix/cli-output";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@staix/cli-output"))));
const fixtures = join(packageRoot, "fixtures/v1");
const read = (name: string): any => JSON.parse(readFileSync(join(fixtures, name), "utf8"));

for (const c of read("color.json")) test(`installed color fixture: ${c.id}`, () => {
  const result = resolveColor(c.flag, c.env, "tool");
  if (c.expectedError !== undefined) expect(result).toEqual(new Error(c.expectedError));
  else expect(result).toBe(c.expected);
});
for (const c of read("markers.json")) test(`installed marker fixture: ${c.id}`, () => {
  expect(markerCell(c.name as MarkerName, false)).toBe(c.utf8);
  expect(markerCell(c.name as MarkerName, true)).toBe(c.ascii);
});
for (const c of read("error-line.json")) test(`installed error fixture: ${c.id}`, () => {
  expect(errorLine(c.tool, c.what, c.why, c.options)).toEqual(c.expected);
});
for (const file of readdirSync(join(fixtures, "report")).filter(name => name.endsWith(".json"))) {
  const c = read(join("report", file));
  test(`installed report fixture: ${c.id}`, () => {
    const report = new Report(c.input.columns ?? undefined, c.input.ascii);
    for (const op of c.input.operations) {
      switch (op.op) {
        case "header": report.header(op.tool, op.name, op.context); break;
        case "section": report.section(op.name, op.count); break;
        case "kv": report.kv(op.rows); break;
        case "bullet": report.bullet(op.marker, op.text, op.nested); break;
        case "next": report.next(op.command); break;
        case "table": report.table(op.head, op.rows, op.flexible); break;
        case "summary": report.summary(op.counts); break;
        default: throw new Error(`Unknown fixture operation: ${op.op}`);
      }
    }
    expect(report.render(false)).toEqual(c.plain);
    expect(report.render(true)).toEqual(c.colored);
  });
}
test("installed standard exit codes", () => expect(EXIT).toEqual({ ok: 0, fail: 1, usage: 2, tempfail: 75 }));
