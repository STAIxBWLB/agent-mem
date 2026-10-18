import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryMcp } from "../src/mcp-memory.ts";
import { registerReaderLease } from "../src/memory/reader-lease.ts";
import { readerAdmissionDatabase } from "../src/memory/mutation.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const fixture = () => { const root = mkdtempSync(join(tmpdir(), "amem-work-cost-")); roots.push(root); return root; };

test("bound lease verification preserves ownership and profile-lock refusal without readmission", () => {
  const base = fixture(), release = registerReaderLease(base);
  try {
    const file = join(base, "readers", readdirSync(join(base, "readers"))[0]!);
    const original = readFileSync(file, "utf8");
    const fence = readerAdmissionDatabase(base);
    try { fence.run("BEGIN IMMEDIATE"); release.verify(); }
    finally { fence.run("ROLLBACK"); fence.close(); }
    expect(readFileSync(file, "utf8")).toBe(original);
    writeFileSync(join(base, "profile.lock"), "unverifiable");
    expect(() => release.verify()).toThrow(/profile lock/i);
    rmSync(join(base, "profile.lock"));
    writeFileSync(file, original.replace('"signature":', '"unknown":'));
    expect(() => release.verify()).toThrow();
    writeFileSync(file, original); release.verify();
    rmSync(file); expect(() => release.verify()).toThrow();
    writeFileSync(file, original);
  } finally { release(); }
  expect(() => release.verify()).toThrow();
});

test("screening multiple work rows never re-probes process identity after startup", async () => {
  const root = fixture(), base = join(root, "memory");
  const mcp = createMemoryMcp({ cwd: root, base, project: "work-cost" });
  const previousPath = process.env.PATH, previousProbe = process.env.AMEM_TEST_PS_PROBE;
  try {
    for (let i = 0; i < 12; i++) await mcp.tools.amem_work_state_write({ list: "queue", fields: { task: `work ${i}`, status: "doing" } });
    const bin = join(root, "bin"), probe = join(root, "ps-called"); mkdirSync(bin);
    writeFileSync(join(bin, "ps"), '#!/bin/sh\nprintf called >> "$AMEM_TEST_PS_PROBE"\nexit 1\n', { mode: 0o700 });
    process.env.PATH = `${bin}:${previousPath ?? ""}`; process.env.AMEM_TEST_PS_PROBE = probe;
    const rows = await mcp.tools.amem_work_state_read({ list: "queue" }) as { items: unknown[] }[];
    expect(rows[0]?.items).toHaveLength(12);
    expect(existsSync(probe)).toBe(false);
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousProbe === undefined) delete process.env.AMEM_TEST_PS_PROBE; else process.env.AMEM_TEST_PS_PROBE = previousProbe;
    mcp.close();
  }
});
