import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CaptureStore } from "../src/memory/capture.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { appendAlias } from "../src/memory/shard.ts";

// Resolve the optional new module inside each named test, so the red-first receipt is an assertion failure.
async function ingestTranscript(kind: "codex" | "kimi" | "pi", options: Record<string, unknown>): Promise<any> {
  const target = "../src/ingest.ts";
  let api: { ingestTranscript?: (...args: any[]) => Promise<any> } = {};
  try { api = await import(target); } catch { /* The named assertion reports the absent feature. */ }
  expect(typeof api.ingestTranscript).toBe("function");
  return api.ingestTranscript!(kind, options);
}

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const at = "2026-10-23T01:00:00.000Z";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amem-ingest-")); roots.push(root);
  const cwd = join(root, "project"), other = join(root, "foreign"), base = join(root, "memory"), file = join(root, "transcript.jsonl");
  mkdirSync(cwd); mkdirSync(other);
  return { root, cwd, other, base, file };
}
function rows(f: ReturnType<typeof fixture>) { const store = new CaptureStore({ memoryDir: f.base, project: memoryProjectKey(f.cwd) }); try { return store.rows({ limit: 100 }); } finally { store.close(); } }
const line = (value: unknown) => JSON.stringify(value) + "\n";
const codexHeader = (cwd: string) => ({ timestamp: at, type: "session_meta", payload: { id: "synthetic-session", cwd } });
const codexMessage = (text: string) => ({ timestamp: at, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } });

test("Codex ingestion is incremental, waits for partial tails, and replays a lost cursor idempotently", async () => {
  const f = fixture(); writeFileSync(f.file, line(codexHeader(f.cwd)) + line(codexMessage("first public answer")) + JSON.stringify(codexMessage("partial answer")));
  const first = await ingestTranscript("codex", { ...f, files: [f.file] }); expect(first.imported).toBe(1); expect(first.remaining).toBe(true);
  const idle = await ingestTranscript("codex", { ...f, files: [f.file] }); expect(idle.imported).toBe(0);
  appendFileSync(f.file, "\n"); expect((await ingestTranscript("codex", { ...f, files: [f.file] })).imported).toBe(1);
  const store = new CaptureStore({ memoryDir: f.base, project: memoryProjectKey(f.cwd) }); const cursors = join(store.dir, "ingest"); store.close();
  for (const name of readdirSync(cursors)) if (name.endsWith(".db")) rmSync(join(cursors, name));
  const replay = await ingestTranscript("codex", { ...f, files: [f.file] }); expect(replay.imported).toBe(0); expect(rows(f)).toHaveLength(2);
  const cursorText = readdirSync(cursors).filter(n => n.endsWith(".db")).map(n => readFileSync(join(cursors,n),"utf8")).join("");
  expect(cursorText).not.toContain("first public answer"); expect(cursorText).not.toContain(f.cwd);
});

test("Pi accepts native session/message entries but never foreign, untimed, private or denied complete records", async () => {
  const f = fixture();
  writeFileSync(f.file, line({ type: "session", version: 3, id: "session", timestamp: at, cwd: f.cwd })
    + line({ type: "message", id: "one", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: "public pi answer" }] } })
    + line({ type: "message", id: "two", timestamp: at, private: true, message: { role: "user", content: "hidden" } })
    + line({ type: "message", id: "three", timestamp: at, extra: "never-retain", message: { role: "user", content: "otherwise public" } })
    + line({ type: "message", id: "four", message: { role: "user", content: "missing time" } })
    + line({ type: "message", id: "five", timestamp: at, cwd: f.other, message: { role: "user", content: "foreign answer" } }));
  let screens = 0;
  const receipt = await ingestTranscript("pi", { ...f, files: [f.file], policy: { host: { async screen(value) { screens++; return !JSON.stringify(value).includes("never-retain"); } } } });
  expect(receipt.imported).toBe(1); expect(receipt.errors).toBeGreaterThan(0); expect(screens).toBeGreaterThan(1); expect(rows(f).map(r => r.excerpt)).toEqual(["public pi answer"]);
});

test("Kimi native wire records use session state cwd and numeric source time", async () => {
  const f = fixture(), session = join(f.root,"kimi-session"), main = join(session,"agents","main"); mkdirSync(main,{recursive:true});
  writeFileSync(join(session,"state.json"),JSON.stringify({ cwd: f.cwd })); const file=join(main,"wire.jsonl");
  writeFileSync(file,line({type:"metadata",protocol_version:"1.5"}) + line({type:"context.append_message",time:Date.parse(at),message:{role:"assistant",content:[{type:"text",text:"public kimi answer"}]}}));
  expect((await ingestTranscript("kimi",{...f,files:[file]})).imported).toBe(1); expect(rows(f)[0]?.at).toBe(at);
  writeFileSync(join(session,"state.json"),JSON.stringify({cwd:f.other})); appendFileSync(file,line({type:"context.append_message",time:Date.parse(at),message:{role:"assistant",content:"foreign"}}));
  expect((await ingestTranscript("kimi",{...f,files:[file]})).imported).toBe(0); expect(rows(f)).toHaveLength(1);
});

test("bounded passes resume complete records, reset truncation and refuse linked input", async () => {
  const f=fixture();writeFileSync(f.file,line(codexHeader(f.cwd))+line(codexMessage("one"))+line(codexMessage("two")));
  const first=await ingestTranscript("codex",{...f,files:[f.file],maxBytes:400}); expect(first.remaining).toBe(true);
  await ingestTranscript("codex",{...f,files:[f.file],maxBytes:1000}); expect(rows(f)).toHaveLength(2);
  writeFileSync(f.file,line(codexHeader(f.cwd))+line(codexMessage("replacement")));
  await ingestTranscript("codex",{...f,files:[f.file]}); expect(rows(f).some(r=>r.excerpt==="replacement")).toBe(true);
  const link=join(f.root,"linked.jsonl");symlinkSync(f.file,link);expect((await ingestTranscript("codex",{...f,files:[link]})).errors).toBe(1);
});

test("project aliases are resolved at startup and since never fabricates timestamps", async () => {
  const f=fixture();appendAlias(f.base,{alias:memoryProjectKey(f.other),key:memoryProjectKey(f.cwd),actor:"person",machine:"fixture"});
  writeFileSync(f.file,line(codexHeader(f.other))+line(codexMessage("aliased public answer")));
  expect((await ingestTranscript("codex",{...f,files:[f.file],since:"2026-10-22T00:00:00Z"})).imported).toBe(1);
  const unknown=join(f.root,"unknown.jsonl");writeFileSync(unknown,line(codexMessage("no session scope")));
  const r=await ingestTranscript("codex",{...f,files:[unknown]});expect(r.imported).toBe(0);expect(r.errors).toBeGreaterThan(0);expect(JSON.stringify(r)).not.toContain(f.root);
});
