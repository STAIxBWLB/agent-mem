import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestTranscript } from "../src/ingest.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { memoryProjectKey } from "../src/memory/project.ts";

const roots: string[] = [], restore: (() => void)[] = [];
afterEach(() => {
  for (const reset of restore.splice(0).reverse()) reset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const at = "2026-10-26T01:00:00.000Z", sessionId = "11111111-1111-4111-8111-111111111111";
const line = (value: unknown) => JSON.stringify(value) + "\n";
function env(key: "QWEN_HOME" | "QWEN_RUNTIME_DIR", value: string | undefined) {
  const old = process.env[key];
  restore.push(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amem-qwen-ingest-")); roots.push(root);
  // These two real project paths collide under Qwen's lossy sanitizeCwd.
  const cwd = join(root, "project-a"), other = join(root, "project_a"), base = join(root, "memory"), file = join(root, "transcript.jsonl");
  mkdirSync(cwd); mkdirSync(other);
  return { root, cwd, other, base, file };
}
function message(cwd: string | undefined, text: string, overrides: Record<string, unknown> = {}) {
  return { uuid: randomUUID(), parentUuid: null, sessionId, version: "0.26.1", timestamp: at,
    cwd, type: "assistant", message: { role: "model", parts: [{ text }] }, ...overrides };
}
function rows(f: ReturnType<typeof fixture>) {
  const capture = new CaptureStore({ memoryDir: f.base, project: memoryProjectKey(f.cwd) });
  try { return capture.rows({ limit: 100 }); } finally { capture.close(); }
}
function cursorDirectory(f: ReturnType<typeof fixture>) {
  const capture = new CaptureStore({ memoryDir: f.base, project: memoryProjectKey(f.cwd) });
  try { return join(capture.dir, "ingest"); } finally { capture.close(); }
}

test("Qwen native text and tool parts are bounded captures; thoughts, metadata and media are not excerpts", async () => {
  const f = fixture();
  writeFileSync(f.file, [
    message(f.cwd, "public assistant answer"),
    message(f.cwd, "", { type: "user", sessionId: `${sessionId}-agent-synthetic`, message: { role: "user", parts: [{ text: "public user request" }] } }),
    message(f.cwd, "", { message: { role: "model", parts: [{ functionCall: { id: "call-1", name: "read_file", args: { file_path: "public.ts" } } }] } }),
    message(f.cwd, "", { type: "tool_result", message: { role: "user", parts: [{ functionResponse: { id: "call-1", name: "read_file", response: { output: "public file result" }, parts: [{ inlineData: { mimeType: "image/png", data: "synthetic-media-marker" } }] } }] } }),
    message(f.cwd, "", { message: { role: "model", parts: [{ text: "synthetic thought marker", thought: true }, { text: "final public text" }] } }),
    message(f.cwd, "system-only metadata", { type: "system" }),
    message(f.cwd, "", { message: undefined }),
    message(f.cwd, "", { message: { role: "model", parts: [{ text: "synthetic thought only", thought: true }] } }),
  ].map(line).join(""));
  const receipt = await ingestTranscript("qwen", { ...f, files: [f.file] });
  expect(receipt.imported).toBe(5); expect(receipt.errors).toBe(0);
  const captured = rows(f);
  expect(captured.every(row => row.agent === "qwen")).toBe(true);
  expect(captured.find(row => row.event === "function_call")).toMatchObject({ tool: "read_file" });
  expect(captured.find(row => row.event === "function_call_output")).toMatchObject({ tool: "read_file" });
  expect(JSON.stringify(captured)).toContain("public file result");
  for (const marker of ["synthetic thought", "system-only metadata", "synthetic-media-marker", "inlineData"]) expect(JSON.stringify(captured)).not.toContain(marker);
});

test("Qwen every row proves cwd scope despite colliding folders and never inherits prior scope", async () => {
  const f = fixture();
  const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9]/g, "-");
  expect(sanitize(f.cwd)).toBe(sanitize(f.other));
  writeFileSync(f.file, [message(f.cwd, "own first"), message(undefined, "missing cwd"), message(f.other, "foreign collision"),
    message(undefined, "still no cwd"), message("relative/project", "relative cwd"), message(f.cwd, "own last")].map(line).join(""));
  const result = await ingestTranscript("qwen", { ...f, files: [f.file] });
  expect(result.imported).toBe(2); expect(result.reason).toBe("schema_or_time");
  expect(rows(f).map(row => row.excerpt).sort()).toEqual(["own first", "own last"]);
});

test("Qwen requires the verified CLI ceiling and known envelope/part shapes", async () => {
  const f = fixture();
  writeFileSync(f.file, [
    message(f.cwd, "supported"), message(f.cwd, "future version", { version: "0.27.0" }),
    message(f.cwd, "unknown version", { version: "unknown" }), message(f.cwd, "no version", { version: undefined }),
    message(f.cwd, "missing timestamp", { timestamp: undefined }), message(f.cwd, "invalid uuid", { uuid: "not-a-native-id" }),
    message(f.cwd, "unknown role", { message: { role: "assistant", parts: [{ text: "dual-output role is not native Content" }] } }),
    message(f.cwd, "unknown part", { message: { role: "model", parts: [{ futurePart: "unsupported" }] } }),
    message(f.cwd, "mixed unsupported part", { message: { role: "model", parts: [{ text: "otherwise public", futurePart: "unsupported" }] } }),
    message(f.cwd, "malformed call", { message: { role: "model", parts: [{ functionCall: { name: "read_file", args: "not-an-object" } }] } }),
  ].map(line).join(""));
  const result = await ingestTranscript("qwen", { ...f, files: [f.file] });
  expect(result.imported).toBe(1); expect(result.errors).toBeGreaterThan(0);
  expect(rows(f).map(row => row.excerpt)).toEqual(["supported"]);
  // Skipped versions advance the cursor. A future decoder must bump QWEN_CONTRACT to revisit them.
  expect((await ingestTranscript("qwen", { ...f, files: [f.file] })).read).toBe(0);
  const dir = cursorDirectory(f), cursor = join(dir, readdirSync(dir).find(name => /^[a-f0-9]{64}\.db$/.test(name))!);
  const db = new Database(cursor); try { db.run("UPDATE cursor SET protocol = 'previous-qwen-decoder'"); } finally { db.close(); }
  const replay = await ingestTranscript("qwen", { ...f, files: [f.file] });
  expect(replay.read).toBe(10); expect(replay.imported).toBe(0); expect(rows(f)).toHaveLength(1);
});

test("Qwen screens complete native records and extracted inputs before capture", async () => {
  const f = fixture(); let rawScreens = 0, captureScreens = 0;
  writeFileSync(f.file, [message(f.cwd, "allowed"), message(f.cwd, "private flag", { private: true }),
    message(f.cwd, "otherwise public", { extra: "never-retain" }), message(f.cwd, "denied path", { extra: "hidden.ts" }),
    message(f.cwd, "reject-extracted")].map(line).join(""));
  const result = await ingestTranscript("qwen", { ...f, files: [f.file], policy: { denyPaths: ["hidden.ts"], host: { async screen(value) {
    const row = value as Record<string, unknown>;
    if ("uuid" in row) { rawScreens++; return row.extra !== "never-retain"; }
    captureScreens++; return row.excerpt !== "reject-extracted";
  } } } });
  expect(result.imported).toBe(1); expect(rawScreens).toBeGreaterThan(0); expect(captureScreens).toBeGreaterThan(0);
  expect(rows(f).map(row => row.excerpt)).toEqual(["allowed"]);
});

test("Qwen partial tails, since backfill and lost cursor replay retain existing idempotence", async () => {
  const f = fixture();
  const old = message(f.cwd, "older"), recent = message(f.cwd, "newer", { timestamp: "2026-10-26T03:00:00.000Z" });
  writeFileSync(f.file, line(old) + JSON.stringify(recent));
  const first = await ingestTranscript("qwen", { ...f, files: [f.file], since: "2026-10-26T02:00:00Z" });
  expect(first.imported).toBe(0); expect(first.remaining).toBe(true);
  appendFileSync(f.file, "\n");
  expect((await ingestTranscript("qwen", { ...f, files: [f.file], since: "2026-10-26T02:00:00Z" })).imported).toBe(1);
  expect((await ingestTranscript("qwen", { ...f, files: [f.file] })).imported).toBe(1);
  const dir = cursorDirectory(f);
  for (const name of readdirSync(dir)) if (name.endsWith(".db")) rmSync(join(dir, name));
  expect((await ingestTranscript("qwen", { ...f, files: [f.file] })).imported).toBe(0);
  expect(rows(f).map(row => row.excerpt).sort()).toEqual(["newer", "older"]);
  for (const name of readdirSync(dir)) if (name.endsWith(".db")) {
    const cursor = readFileSync(join(dir, name), "utf8"); expect(cursor).not.toContain(f.cwd); expect(cursor).not.toContain("newer");
  }
});

test("Qwen discovery honors runtime precedence and enters only projects/*/chats plain JSONL", async () => {
  const f = fixture(), home = join(f.root, "qwen-home"), runtime = join(f.root, "qwen-runtime");
  env("QWEN_HOME", home); env("QWEN_RUNTIME_DIR", runtime);
  const chats = join(runtime, "projects", "lossy-project", "chats"); mkdirSync(chats, { recursive: true });
  const homeChats = join(home, "projects", "other", "chats"); mkdirSync(homeChats, { recursive: true });
  writeFileSync(join(homeChats, "home.jsonl"), line(message(f.cwd, "lower-precedence home")));
  writeFileSync(join(chats, "native.jsonl"), line(message(f.cwd, "runtime native")));
  for (const file of [join(runtime, "settings.json"), join(runtime, "oauth_creds.json"), join(runtime, "accounts.jsonl"), join(runtime, "projects", "lossy-project", "outside-chats.jsonl")]) writeFileSync(file, line(message(f.cwd, "must not discover")));
  mkdirSync(join(chats, "nested")); writeFileSync(join(chats, "nested", "ignored.jsonl"), line(message(f.cwd, "nested history")));
  symlinkSync(f.file, join(chats, "linked.jsonl")); writeFileSync(f.file, line(message(f.cwd, "linked source")));
  const result = await ingestTranscript("qwen", { cwd: f.cwd, base: f.base });
  expect(result.files).toBe(1); expect(result.read).toBe(1); expect(result.imported).toBe(1);
  expect(rows(f).map(row => row.excerpt)).toEqual(["runtime native"]);
  env("QWEN_RUNTIME_DIR", undefined);
  expect((await ingestTranscript("qwen", { cwd: f.cwd, base: f.base })).imported).toBe(1);
  expect(rows(f).map(row => row.excerpt).sort()).toEqual(["lower-precedence home", "runtime native"]);
});

test("Qwen discovery rotates bounded files, skips directory links and reports missing roots", async () => {
  const f = fixture(), runtime = join(f.root, "runtime"), chats = join(runtime, "projects", "project", "chats");
  env("QWEN_RUNTIME_DIR", runtime); env("QWEN_HOME", join(f.root, "unused-home")); mkdirSync(chats, { recursive: true });
  writeFileSync(join(chats, "partial.jsonl"), JSON.stringify(message(f.cwd, "unfinished")));
  for (const name of ["one", "two"]) writeFileSync(join(chats, `${name}.jsonl`), line(message(f.cwd, name)));
  symlinkSync(f.root, join(runtime, "projects", "linked-project"));
  const otherProject = join(runtime, "projects", "linked-chats"); mkdirSync(otherProject); symlinkSync(f.root, join(otherProject, "chats"));
  for (let i = 0; i < 5; i++) await ingestTranscript("qwen", { cwd: f.cwd, base: f.base, maxFiles: 1 });
  expect(rows(f).map(row => row.excerpt).sort()).toEqual(["one", "two"]);
  env("QWEN_RUNTIME_DIR", join(f.root, "missing"));
  const missing = await ingestTranscript("qwen", { cwd: f.cwd, base: f.base });
  expect(missing.reason).toBe("source_unavailable"); expect(missing.imported).toBe(0);
});

test("#136: a newer Qwen writer version is reported as unsupported_version, a malformed record still as schema_or_time, and both stay replayable", async () => {
  const f = fixture();
  writeFileSync(f.file, line(message(f.cwd, "newer writer answer", { version: "0.27.0" })));
  const newer = await ingestTranscript("qwen", { ...f, files: [f.file] });
  expect(newer).toMatchObject({ imported: 0, reason: "unsupported_version", version: "0.27.0" });
  expect(JSON.stringify(newer)).not.toContain("newer writer answer");
  const malformed = join(f.root, "bad.jsonl");
  writeFileSync(malformed, line(message(f.cwd, "x", { version: "0.26.1", uuid: "not-a-uuid" })));
  const bad = await ingestTranscript("qwen", { cwd: f.cwd, base: f.base, files: [malformed] });
  expect(bad.reason).toBe("schema_or_time"); expect(bad.version).toBeUndefined();
  const hostile = join(f.root, "hostile.jsonl");
  writeFileSync(hostile, line(message(f.cwd, "x", { version: "secret transcript text that is long" })));
  const refused = await ingestTranscript("qwen", { ...f, files: [hostile] });
  expect(refused.reason).toBe("schema_or_time"); expect(refused.version).toBeUndefined();
  // Cursor semantics unchanged: the Qwen cursor is keyed by its decoder contract, so a decoder update replays the skipped versions.
  writeFileSync(f.file, line(message(f.cwd, "supported answer")));
  expect((await ingestTranscript("qwen", { ...f, files: [f.file] })).imported).toBe(1);
});

test("#136: a policy-declined Qwen record reports no version, and a bare dashed number is never a version token", async () => {
  const f = fixture();
  writeFileSync(f.file, line(message(f.cwd, "declined", { version: "0.27.0", marker: "decline-me" })));
  const policy = { host: { async screen(value: unknown) { return !JSON.stringify(value).includes("decline-me"); } } };
  const declined = await ingestTranscript("qwen", { ...f, files: [f.file], policy });
  expect(declined.reason).toBe("schema_or_time"); expect(declined.version).toBeUndefined(); expect(JSON.stringify(declined)).not.toContain("0.27.0");
  const ssn = join(f.root, "ssn.jsonl");
  writeFileSync(ssn, line(message(f.cwd, "x", { version: "000-00-0000" })));
  const refused = await ingestTranscript("qwen", { cwd: f.cwd, base: f.base, files: [ssn] });
  expect(refused.reason).toBe("schema_or_time"); expect(refused.version).toBeUndefined(); expect(JSON.stringify(refused)).not.toContain("000-00-0000");
  const plus = join(f.root, "plus.jsonl");
  writeFileSync(plus, line(message(f.cwd, "x", { version: "0.27.0-rc.1" })));
  expect(await ingestTranscript("qwen", { cwd: f.cwd, base: f.base, files: [plus] })).toMatchObject({ reason: "unsupported_version", version: "0.27.0-rc.1" });
});

test("#136: a Qwen version the current policy declines is never reported", async () => {
  const f = fixture();
  mkdirSync(f.base, { recursive: true }); writeFileSync(join(f.base, "amem.config.json"), JSON.stringify({ piiPatterns: ["internal"] }));
  writeFileSync(f.file, line(message(f.cwd, "x", { version: "0.27.0-internal" })));
  const receipt = await ingestTranscript("qwen", { ...f, files: [f.file] });
  expect(receipt.reason).toBe("schema_or_time"); expect(receipt.version).toBeUndefined(); expect(JSON.stringify(receipt)).not.toContain("internal");
});
