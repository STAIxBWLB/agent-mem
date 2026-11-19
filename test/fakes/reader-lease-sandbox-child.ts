import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";
import { MemoryStore, openShardStore } from "../../src/memory/store.ts";
import { processSignature } from "../../src/memory/platform.ts";
import { registerReaderLease } from "../../src/memory/reader-lease.ts";

const [home, mode] = process.argv.slice(2);
if (!home || !mode) throw Error("isolated sandbox fixture needs a home and mode");
const input = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
console.log(JSON.stringify({ phase: "ready", pid: process.pid }));
const signature = (await input.next()).value;
if (typeof signature !== "string") throw Error("host identity was not received");
const self = processSignature(process.pid), other = processSignature(1);
const ps = spawnSync("/bin/sh", ["-c", "exec /bin/ps -p 1 -o lstart=,comm="], { encoding: "utf8" });
let defaultRefused = false;
try { registerReaderLease(home)(); } catch (error) { defaultRefused = error instanceof Error && error.message === "cannot establish reader lease identity"; }
const store = mode === "shard" ? openShardStore({ memoryDir: home, project: "sandbox-project", readerLeaseSignature: signature }) : new MemoryStore({ memoryDir: home, readerLeaseSignature: signature });
try {
  console.log(JSON.stringify({ phase: "leased", pid: process.pid, self: self ?? null, other: other ?? null, psStatus: ps.status, psOutput: ps.stdout ?? "", psError: ps.stderr ?? "", defaultRefused }));
  await input.next();
} finally { store.close(); }
