import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("isolated real prune writer target placement and proof mutants fail the frozen compatibility gate", () => {
  const root = mkdtempSync(join(tmpdir(), "amem-isolated-writer-mutants-"));
  try {
    mkdirSync(join(root, "src", "memory"), { recursive: true }); mkdirSync(join(root, "test", "fixtures"), { recursive: true }); mkdirSync(join(root, "tmp"));
    // This explicit small list mirrors the fixture's import closure. No dependency/build trees or user data are copied.
    for (const name of ["store", "generation", "generation-index", "bridge", "platform", "mutation", "home", "prune", "ops-contract", "migrate", "screen", "search-fts", "capture", "shard", "reader-lease", "shard-bridge"]) writeFileSync(join(root, "src", "memory", `${name}.ts`), readFileSync(new URL(`../src/memory/${name}.ts`, import.meta.url)));
    writeFileSync(join(root, "test", "generation-replay.test.ts"), readFileSync(new URL("./generation-replay.test.ts", import.meta.url)));
    writeFileSync(join(root, "test", "fixtures", "generation-prune.json"), readFileSync(new URL("./fixtures/generation-prune.json", import.meta.url)));
    const run = () => Bun.spawnSync([process.execPath, "test", "test/generation-replay.test.ts", "--test-name-pattern", "real generation prune writer matches"], {
      cwd: root, stdout: "pipe", stderr: "pipe", timeout: 10000, env: { ...process.env, TMPDIR: join(root, "tmp"), AGENTHUB_HOME: join(root, "default"), AMEM_HOME: join(root, "default", "memory") },
    });
    expect(run().exitCode).toBe(0); // Positive control prevents an import/setup failure from masquerading as a caught mutant.
    const path = join(root, "src", "memory", "prune.ts"), original = readFileSync(path, "utf8");
    const mutants = [
      ['const target: PruneTarget = { id, rowHash:', 'const target: PruneTarget = { id: "f".repeat(32), rowHash:'],
      ['if (!auth.policy) return "local";', 'if (!auth.policy) return "synced";'],
      ['rowHash: pruneRowHash(basis) } };', 'rowHash: "0".repeat(64) } };'],
    ];
    for (const [before, after] of mutants) {
      expect(original.split(before!).length).toBe(2);
      writeFileSync(path, original.replace(before!, after!));
      const result = run(), output = new TextDecoder().decode(result.stderr);
      expect(result.exitCode).toBe(1);
      expect(output).toContain("(fail) real generation prune writer matches");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
