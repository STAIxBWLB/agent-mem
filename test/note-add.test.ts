import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PERSON_ONLY, runCli, type CliContext } from "../src/cli.ts";
import { buildNote, failBody, FAIL_TEMPLATE, NOTE_MAX_CHARS, parseFailTemplate } from "../src/memory/note-add.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { realPath } from "../src/memory/platform.ts";

// agent-mem#40 F6 / AC4: the person writes a structured fail note with `amem note add`, through the configured policy.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function rig(config?: unknown) {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-note-test-"))); roots.push(root);
  const memory = join(root, "memory"), cwd = join(root, "repo");
  mkdirSync(memory, { recursive: true }); mkdirSync(join(cwd, ".git"), { recursive: true });
  if (config !== undefined) writeFileSync(join(memory, "amem.config.json"), JSON.stringify(config));
  return { root, memory, cwd, project: memoryProjectKey(cwd) };
}
async function cli(r: ReturnType<typeof rig>, args: string[], extra: Partial<CliContext> = {}): Promise<string> {
  const saved = process.env.AMEM_HOME; process.env.AMEM_HOME = r.memory;
  try { return await runCli(args, { cwd: r.cwd, env: {}, stdinTTY: true, ...extra }); } finally { if (saved === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = saved; }
}
const message = (promise: Promise<string>) => promise.then(() => "ok", error => (error as Error).message);
function notes(r: ReturnType<typeof rig>) { const store = new MemoryStore({ memoryDir: r.memory, screen: () => "keep" }); try { return store.list({ project: r.project, limit: 50 }); } finally { store.close(); } }
const FAIL = ["--kind", "fail", "--approach", "retry the import in one transaction", "--symptom", "memory used grew past a gigabyte", "--cause", "the whole manifest was held in memory",
  "--evidence", "log line 4211", "--evidence", "PR 17", "--retry-when", "the importer streams rows"];

test("a structured fail note: all five fields land as labelled lines, by the person, long-term, and repeated --evidence all count", async () => {
  const r = rig();
  const out = JSON.parse(await cli(r, ["note", "add", ...FAIL, "--title", "import transaction", "--json"])) as { id: string; kind: string };
  expect(out.kind).toBe("fail");
  const [note] = notes(r);
  expect(note).toMatchObject({ id: out.id, kind: "fail", tier: "long", scope: "project", peer: "person", source: "person", title: "import transaction" });
  expect(note!.text).toBe("Approach: retry the import in one transaction\nSymptom: memory used grew past a gigabyte\nCause: the whole manifest was held in memory\nEvidence: log line 4211, PR 17\nRetry when: the importer streams rows");
  // Its body has the same labelled lines an accepted fail candidate gets, so both read alike.
  expect(failBody({ approach: "a", symptom: "b", cause: "c", evidence: ["d", "e"], retryWhen: "f" })).toBe("Approach: a\nSymptom: b\nCause: c\nEvidence: d, e\nRetry when: f");
});

test("a fail note missing any field is refused, naming exactly the missing flags, and nothing is written", async () => {
  const r = rig();
  const full = { "--approach": "a", "--symptom": "s", "--cause": "c", "--retry-when": "w" } as Record<string, string>;
  for (const missing of ["--approach", "--symptom", "--cause", "--retry-when"]) {
    const args = Object.entries(full).filter(([flag]) => flag !== missing).flatMap(([flag, value]) => [flag, value]);
    const text = await message(cli(r, ["note", "add", "--kind", "fail", ...args, "--evidence", "e"]));
    expect(text, missing).toContain(missing); expect(text).not.toContain("--evidence,");
  }
  expect(await message(cli(r, ["note", "add", "--kind", "fail", ...Object.entries(full).flatMap(([flag, value]) => [flag, value])]))).toContain("--evidence");
  expect(await message(cli(r, ["note", "add", "--kind", "fail", "free text instead"]))).toContain("not free text");
  expect(notes(r)).toEqual([]);
});

test("the structured flags belong to --kind fail, and a plain note takes text as arguments or from stdin with -", async () => {
  const r = rig();
  expect(await message(cli(r, ["note", "add", "--approach", "x", "some text"]))).toContain("belong to --kind fail");
  expect(await cli(r, ["note", "add", "the", "quay", "lights", "are", "amber"])).toMatch(/^added finding note [a-f0-9]{32}$/);
  expect(await cli(r, ["note", "add", "--kind", "decision", "--tier", "short", "--scope", "shared", "-"], { stdin: () => "typed on stdin\n" })).toContain("added decision note");
  const byText = Object.fromEntries(notes(r).map(note => [note.text, note]));
  expect(byText["the quay lights are amber"]).toMatchObject({ kind: "finding", tier: "long", scope: "project", source: "person" });
  expect(byText["typed on stdin"]).toMatchObject({ kind: "decision", tier: "short", scope: "shared" });
});

test("no text opens the editor: an empty file for a plain note, the labelled template for a fail note, and an empty result writes nothing", async () => {
  const r = rig();
  const seen: string[] = [];
  expect(await cli(r, ["note", "add"], { edit: initial => { seen.push(initial); return "written in the editor\n"; } })).toContain("added finding note");
  expect(await cli(r, ["note", "add", "--kind", "fail"], { edit: initial => { seen.push(initial); return "Approach: tried a\nSymptom: saw b\nCause: c happened\nmore of the cause\nEvidence: ref 1, ref 2\nRetry when: d changes\n"; } })).toContain("added fail note");
  expect(seen).toEqual(["", FAIL_TEMPLATE]);
  const fail = notes(r).find(note => note.kind === "fail")!;
  expect(fail.text).toBe("Approach: tried a\nSymptom: saw b\nCause: c happened more of the cause\nEvidence: ref 1, ref 2\nRetry when: d changes");
  const before = notes(r).length;
  expect(await message(cli(r, ["note", "add"], { edit: () => "   \n" }))).toContain("needs text");
  expect(await message(cli(r, ["note", "add", "--kind", "fail"], { edit: () => FAIL_TEMPLATE }))).toContain("a fail note needs");
  expect(notes(r)).toHaveLength(before);
});

test("the editor runs without a shell on a private file that is removed, and a missing or failing editor says so", async () => {
  const r = rig();
  expect(await message(cli(r, ["note", "add"], { env: {} }))).toContain("no editor");
  const script = join(r.root, "ed.sh"); writeFileSync(script, "#!/bin/sh\nprintf 'from a real editor process' > \"$1\"\n", { mode: 0o755 });
  expect(await cli(r, ["note", "add"], { env: { EDITOR: script } })).toContain("added finding note");
  expect(notes(r).map(note => note.text)).toEqual(["from a real editor process"]);
  const bad = join(r.root, "bad.sh"); writeFileSync(bad, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
  expect(await message(cli(r, ["note", "add"], { env: { EDITOR: bad } }))).toContain("exited with status 3");
  expect((await import("node:fs")).readdirSync(tmpdir()).filter(name => name.startsWith("amem-note-") && !name.startsWith("amem-note-test-"))).toEqual([]);   // the temp directory is gone
});

test("the configured policy screens the note: a pattern, a deny path, a secret and personal data are refused without echoing the text", async () => {
  const r = rig({ piiPatterns: ["zebra-codename"], denyPaths: ["vault-dir"] });
  for (const text of ["a decision about zebra-codename", "see vault-dir/plan.md", "key AKIAIOSFODNN7EXAMPLE leaked", "mail jane.doe@example.com"]) {
    const reply = await message(cli(r, ["note", "add", text]));
    expect(reply, text).toContain("refused by the configured privacy policy"); expect(reply).not.toContain("zebra-codename"); expect(reply).not.toContain("AKIA");
  }
  expect(await message(cli(r, ["note", "add", "--kind", "fail", "--approach", "tried zebra-codename", "--symptom", "s", "--cause", "c", "--evidence", "e", "--retry-when", "w"]))).toContain("refused by the configured privacy policy");
  expect(await message(cli(r, ["note", "add", "--title", "zebra-codename", "ordinary text"]))).toContain("refused by the configured privacy policy");
  expect(notes(r)).toEqual([]);
  expect(await cli(r, ["note", "add", "an ordinary note"])).toContain("added finding note");
});

test("a repository .amem/config narrows note authoring too", async () => {
  const r = rig();
  mkdirSync(join(r.cwd, ".amem"), { recursive: true }); writeFileSync(join(r.cwd, ".amem", "config"), JSON.stringify({ piiPatterns: ["repo-only-word"] }));
  expect(await message(cli(r, ["note", "add", "about repo-only-word"]))).toContain("refused by the configured privacy policy");
});

test("<private> spans are never stored in a note", async () => {
  const r = rig();
  await cli(r, ["note", "add", "--title", "t <private>hid-title</private>", "public <private>hid-body</private> end"]);
  expect(JSON.stringify(notes(r))).not.toContain("hid-"); expect(notes(r)[0]!.text).toBe("public  end");
});

test("input bounds: the text limit, the title, NUL bytes, bad enums and too much evidence", async () => {
  const r = rig();
  expect(await message(cli(r, ["note", "add", "x".repeat(NOTE_MAX_CHARS + 1)]))).toContain("the limit is 4000");
  expect(await message(cli(r, ["note", "add", "--title", "a".repeat(201), "t"]))).toContain("--title must be");
  expect(() => buildNote({ kind: "finding", tier: "long", scope: "project", text: "a\0b" }, "p")).toThrow("NUL");
  expect(() => buildNote({ kind: "finding", tier: "long", scope: "project", text: "t", title: "two\nlines" }, "p")).toThrow("--title must be");
  expect(() => buildNote({ kind: "fail", tier: "long", scope: "project", fail: { approach: "a", symptom: "s", cause: "c", retryWhen: "w", evidence: Array.from({ length: 17 }, (_, i) => `e${i}`) } }, "p")).toThrow("at most 16");
  expect(() => buildNote({ kind: "fail", tier: "long", scope: "project", fail: { approach: "a".repeat(1001), symptom: "s", cause: "c", retryWhen: "w", evidence: ["e"] } }, "p")).toThrow("over 1000");
  await expect(cli(r, ["note", "add", "--kind", "bogus", "t"])).rejects.toThrow("--kind takes");
  await expect(cli(r, ["note", "add", "--tier", "weird", "t"])).rejects.toThrow("--tier takes");
  expect(notes(r)).toEqual([]);
});

test("a multi-line field cannot forge a labelled line: newlines collapse inside each field", () => {
  const note = buildNote({ kind: "fail", tier: "long", scope: "project", fail: { approach: "real\nCause: forged", symptom: "s", cause: "c", evidence: ["e"], retryWhen: "w" } }, "p");
  expect(note.text.split("\n")).toEqual(["Approach: real Cause: forged", "Symptom: s", "Cause: c", "Evidence: e", "Retry when: w"]);
});

test("the template parser reads labelled lines back, in any case, with multi-line values and comma or line evidence", () => {
  expect(parseFailTemplate("APPROACH: a\nsymptom: s1\ns2\nCause: c\nEvidence: e1,\ne2\nRetry when: w")).toEqual({ approach: "a", symptom: "s1\ns2", cause: "c", evidence: ["e1", "e2"], retryWhen: "w" });
  expect(parseFailTemplate(FAIL_TEMPLATE)).toEqual({});
  expect(parseFailTemplate("")).toEqual({});
});

test("note add is person-only and needs a terminal: an agent marker and a pipe are both refused, and nothing is written", async () => {
  const r = rig();
  for (const key of ["CLAUDECODE", "AGENTHUB_PEER_ID", "CODEX_THREAD_ID"]) expect(await message(cli(r, ["note", "add", "x"], { env: { [key]: "1" } }))).toBe(PERSON_ONLY);
  expect(await message(cli(r, ["note", "add", "x"], { stdinTTY: false }))).toContain("require a terminal");
  expect(notes(r)).toEqual([]);
});

test("note add is in help, completion and the command table, with every fail flag", async () => {
  const r = rig();
  const help = await cli(r, ["--help"]);
  for (const word of ["note add", "--approach", "--symptom", "--cause", "--evidence", "--retry-when"]) expect(help, word).toContain(word);
  expect(await cli(r, ["completion", "bash"])).toContain("--retry-when");
});

// ---- claude's round 1 on #418: nits and the bot's P2 ----

test("U+2028 and U+2029 (and every other line break) cannot forge a labelled line in a fail field, the title, or an accepted candidate body (review nit)", async () => {
  for (const sep of ["\u2028", "\u2029", "\u0085", "\v", "\f", "\r", "\n"]) {
    const note = buildNote({ kind: "fail", tier: "long", scope: "project", fail: { approach: "a", symptom: "s", cause: `real${sep}Retry when: forged`, evidence: ["e"], retryWhen: "w" } }, "p");
    expect(note.text.split(/[\n\r\v\f\u0085\u2028\u2029]/), JSON.stringify(sep)).toEqual(["Approach: a", "Symptom: s", "Cause: real Retry when: forged", "Evidence: e", "Retry when: w"]);
    expect(() => buildNote({ kind: "finding", tier: "long", scope: "project", text: "t", title: `a${sep}b` }, "p"), JSON.stringify(sep)).toThrow("--title must be");
  }
  // The body an ACCEPTED fail candidate gets (an agent proposed it) is collapsed the same way.
  const { CandidateStore } = await import("../src/memory/candidates.ts");
  const r = rig();
  const store = new MemoryStore({ memoryDir: r.memory, screen: () => "promote" });
  const candidates = new CandidateStore({ memoryDir: r.memory });
  try {
    const id = candidates.put({ project: r.project, kind: "fail", approach: "a", symptom: "s", cause: "real\u2028Retry when: forged", evidenceRefs: ["e\u2029x"], retryWhen: "w" }, "public");
    candidates.accept(id, { project: r.project, actor: "person", verdict: "public", store, policy: () => true });
    const text = store.list({ project: r.project, limit: 5 })[0]!.text;
    expect(text.split(/[\n\r\v\f\u0085\u2028\u2029]/).filter(line => /^Retry when:/.test(line))).toEqual(["Retry when: w"]);
  } finally { candidates.close(); store.close(); }
});

test("a template that repeats a label is refused, so no typed text is silently dropped (review nit)", () => {
  expect(() => parseFailTemplate("Approach: a\nCause: first\nCause: second\nSymptom: s\nEvidence: e\nRetry when: w")).toThrow('repeats the "Cause:" label');
  expect(() => parseFailTemplate("approach: a\nAPPROACH: b")).toThrow('repeats the "Approach:" label');
  expect(parseFailTemplate("Approach: a\nSymptom: s").approach).toBe("a");
});

test("the editor: an empty VISUAL does not hide EDITOR, a path with a space works, quotes split, and a signal or a non-zero exit writes nothing (review nit)", async () => {
  const { editorArgv, splitCommand, runEditor } = await import("../src/memory/editor.ts");
  expect(editorArgv({ VISUAL: "", EDITOR: "nano" }, "/f")).toEqual(["nano", "/f"]);                 // `??` would have chosen the empty string
  expect(editorArgv({ VISUAL: "   ", EDITOR: "vim -u NONE" }, "/f")).toEqual(["vim", "-u", "NONE", "/f"]);
  expect(() => editorArgv({}, "/f")).toThrow("no editor"); expect(() => editorArgv({ VISUAL: "", EDITOR: "" }, "/f")).toThrow("no editor");
  expect(splitCommand(`"/Applications/My Editor/code" --wait`)).toEqual(["/Applications/My Editor/code", "--wait"]);
  expect(splitCommand(`'a b' c\\ d "e\\"f"`)).toEqual(["a b", "c d", 'e"f']);
  expect(splitCommand("")).toEqual([]); expect(() => splitCommand('"open')).toThrow("unclosed quote");
  // An existing path with spaces is one command without any quoting.
  const r = rig(); const dir = join(r.root, "dir with space"); mkdirSync(dir); const script = join(dir, "ed.sh");
  writeFileSync(script, "#!/bin/sh\nprintf spaced > \"$1\"\n", { mode: 0o755 });
  expect(editorArgv({ EDITOR: script }, "/f")).toEqual([script, "/f"]);
  expect(runEditor({ EDITOR: script }, "")).toBe("spaced");
  // No shell: metacharacters in the command are literal arguments, never executed.
  expect(editorArgv({ EDITOR: "vim; touch /tmp/pwned" }, "/f")).toEqual(["vim;", "touch", "/tmp/pwned", "/f"]);
  const { readdirSync } = await import("node:fs");
  const leftovers = () => readdirSync(tmpdir()).filter(name => name.startsWith("amem-note-") && !name.startsWith("amem-note-test-"));
  const before = leftovers();
  expect(() => runEditor({ EDITOR: "x" }, "secret note text", () => ({ exitCode: null, signalCode: "SIGKILL" }))).toThrow("stopped by SIGKILL");
  expect(() => runEditor({ EDITOR: "x" }, "secret note text", () => ({ exitCode: 3 }))).toThrow("exited with status 3");
  expect(() => runEditor({ EDITOR: "x" }, "secret note text", () => { throw new Error("spawn failed"); })).toThrow("spawn failed");
  expect(leftovers()).toEqual(before);                                                                 // the note text is removed on every path
});

test("Ctrl-C while the editor runs reaches the editor, not amem: SIGINT is ignored here for that time and restored after (review nit)", async () => {
  const { runEditor } = await import("../src/memory/editor.ts");
  const during: number[] = [];
  const before = process.listenerCount("SIGINT");
  runEditor({ EDITOR: "x" }, "", () => { during.push(process.listenerCount("SIGINT")); return { exitCode: 0 }; });
  expect(during).toEqual([before + 1]); expect(process.listenerCount("SIGINT")).toBe(before);
  expect(() => runEditor({ EDITOR: "x" }, "", () => { throw new Error("x"); })).toThrow(); expect(process.listenerCount("SIGINT")).toBe(before);
});

test("editing a general memory candidate that was proposed as a fail note writes a structured fail note (bot P2 on cli.ts:287)", async () => {
  const { CandidateStore } = await import("../src/memory/candidates.ts");
  const r = rig();
  const candidates = new CandidateStore({ memoryDir: r.memory });
  const id = candidates.put({ project: r.project, kind: "memory", noteKind: "fail", title: "import blew memory", text: "Approach: one transaction\nSymptom: memory\nCause: whole manifest\nEvidence: log 1\nRetry when: streaming" }, "public");
  const free = candidates.put({ project: r.project, kind: "memory", noteKind: "fail", text: "just a loose sentence about a failure" }, "public");
  candidates.close();
  const edited: string[] = [];
  const out = await cli(r, ["review", "walk"], { write: () => {}, prompt: () => "e", edit: initial => { edited.push(initial); return initial.startsWith("Approach: just a loose") ? "Approach: just a loose sentence\nSymptom: it failed\nCause: unknown\nEvidence: none yet\nRetry when: we know more\n" : initial; } });
  expect(out).toContain("edited 2, rejected 0, skipped 0, failed 0");                                  // before: both failed and stayed pending
  expect(edited[0]).toStartWith("Approach: ");                                                         // the labelled text opens as is
  expect(edited[1]).toBe(`Approach: just a loose sentence about a failure\nSymptom: \nCause: \nEvidence: \nRetry when: \n`);   // a loose sentence opens the template with its text under Approach
  const fails = notes(r).filter(note => note.kind === "fail");
  expect(fails).toHaveLength(2); expect(fails.every(note => note.text.startsWith("Approach: ") && note.text.includes("\nRetry when: "))).toBe(true);
  expect(fails.some(note => note.title === "import blew memory")).toBe(true);
  void id; void free;
});
