import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { processLiveness, processSignature, realPath } from "../src/memory/platform.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";

test("explicit reader identity matches the default lease and rejects a conflicting nested assertion", () => {
  const home = realPath(mkdtempSync(join(tmpdir(), "amem-reader-host-identity-"))); chmodSync(home, 0o700);
  try {
    const signature = processSignature(process.pid); expect(signature).toMatch(/^[a-f0-9]{64}$/);
    const original = new MemoryStore({ memoryDir: home, deferPromotions: true });
    try {
      const nested = new MemoryStore({ memoryDir: home, deferPromotions: true, readerLeaseSignature: signature });
      try {
        expect(readdirSync(join(home, "readers"))).toEqual([`${process.pid}-${signature}.json`]);
        expect(() => new MemoryStore({ memoryDir: home, readerLeaseSignature: "f".repeat(64) })).toThrow("reader lease identity changed");
      } finally { nested.close(); }
    } finally { original.close(); }
    expect(() => new MemoryStore({ memoryDir: home, readerLeaseSignature: "invalid" })).toThrow("invalid reader lease identity");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

for (const mode of ["legacy", "shard"] as const) {
  test.skipIf(process.platform !== "darwin" || process.arch !== "arm64")(`host identity admits a ${mode} reader in a setuid-exec-restricted sandbox`, async () => {
    const home = realPath(mkdtempSync(join(tmpdir(), "amem-sandbox-reader-"))); chmodSync(home, 0o700);
    if (mode === "shard") {
      const initial = new MemoryStore({ memoryDir: home, deferPromotions: true }); initial.close();
      await migrateShards({ memoryDir: home, generation: "a".repeat(32), mode: "apply", authorizedPerson: true, tty: true });
    }
    // The profile grants only same-sandbox process inspection; no copy of ps or additional process grant is installed.
    const profile = `(version 1)(deny default)(allow process-fork)(allow process-exec)(allow signal (target same-sandbox))(allow process-info* (target same-sandbox))(allow sysctl-read)(allow file-read*)(allow file-write* (subpath ${JSON.stringify(home)}) (literal "/dev/null"))(allow file-ioctl)(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.system.DirectoryService.libinfo_v1") (global-name "com.apple.system.logger") (global-name "com.apple.system.notification_center"))(allow ipc-posix-shm-read-data ipc-posix-shm-read-metadata (ipc-posix-name "apple.shm.notification_center"))`;
    const child = spawn("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, join(import.meta.dir, "fakes/reader-lease-sandbox-child.ts"), home, mode], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PATH: "/bin:/usr/bin", LC_ALL: "C" } });
    let stderr = ""; child.stderr.setEncoding("utf8"); child.stderr.on("data", text => { stderr += text; });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
    try {
      const ready = JSON.parse((await lines.next()).value ?? "null") as { phase: string; pid: number };
      expect(child.pid).toBeDefined();
      expect(ready).toEqual({ phase: "ready", pid: child.pid! });
      const signature = processSignature(ready.pid); expect(signature).toMatch(/^[a-f0-9]{64}$/);
      child.stdin.write(signature + "\n");
      const leased = JSON.parse((await lines.next()).value ?? "null") as { phase: string; pid: number; self: string | null; other: string | null; psStatus: number | null; psOutput: string; psError: string; defaultRefused: boolean };
      expect(leased).toMatchObject({ phase: "leased", pid: ready.pid, self: null, other: null, psOutput: "", defaultRefused: true });
      expect(leased.psStatus).not.toBe(0);
      expect(leased.psError).toContain("Operation not permitted");
      const folder = join(home, mode === "shard" ? "shard-readers" : "readers");
      const names = readdirSync(folder); expect(names).toEqual([`${ready.pid}-${signature}.json`]);
      const lease = JSON.parse(readFileSync(join(folder, names[0]!), "utf8"));
      expect(lease).toMatchObject({ pid: ready.pid, signature });
      expect(processLiveness(ready.pid, lease.signature)).toBe("live");
      child.stdin.end("close\n");
      expect(await exited, stderr).toEqual({ code: 0, signal: null });
      expect(readdirSync(folder)).toEqual([]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
}
