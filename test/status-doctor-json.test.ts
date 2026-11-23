import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";

// #590: the human status/doctor reports changed; `--json` must stay byte-identical to main (78e411bb) for the same home.
// The goldens were written from that main commit by running this file with AMEM_WRITE_JSON_GOLDEN=1 before the renderer change.
const GOLDEN = join(import.meta.dir, "fixtures", "status-doctor-json");
// A macOS tmpdir resolves through /private; both spellings of the scratch paths normalize to the same token.
const normalize = (text: string, home: string, cwd: string) => text.replaceAll(`/private${home}`, "<home>").replaceAll(home, "<home>").replaceAll(`/private${cwd}`, "<cwd>").replaceAll(cwd, "<cwd>")
  .replace(/amem-json-cwd-[A-Za-z0-9]+@[0-9a-f]+/g, "<project>").replace(/"\d{4}-\d{2}-\d{2}T[0-9:.]+Z"/g, "\"<time>\"");

for (const command of ["status", "doctor"] as const) {
  test(`#590: ${command} --json is byte-identical to main`, async () => {
    const home = mkdtempSync(join(tmpdir(), "amem-json-golden-")), cwd = mkdtempSync(join(tmpdir(), "amem-json-cwd-"));
    const prior = process.env.AMEM_HOME; process.env.AMEM_HOME = home;
    let text: string;
    try { text = normalize(await runCli([command, "--json"], { cwd, env: { ...process.env, AMEM_HOME: home }, stdinTTY: false }), home, cwd); }
    finally { if (prior === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = prior; }
    const file = join(GOLDEN, `${command}.json`);
    if (process.env.AMEM_WRITE_JSON_GOLDEN === "1" || !existsSync(file)) { if (process.env.AMEM_WRITE_JSON_GOLDEN !== "1") throw Error(`missing golden ${file}`); writeFileSync(file, text); }
    expect(text).toBe(readFileSync(file, "utf8"));
  }, 60_000);
}
