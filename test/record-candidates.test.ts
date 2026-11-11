import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureSessionKey } from "../src/memory/capture-input.ts";
import { CaptureStore, type CaptureRow } from "../src/memory/capture.ts";
import { CandidateStore } from "../src/memory/candidates.ts";
import { proposeConsolidation, type ConsolidationOptions } from "../src/memory/consolidate.ts";
import { createStandalonePolicy } from "../src/memory/policy.ts";
import { recordCandidates, recordCaptureLookup, recordSourceCheck, type RecordCandidateWindow } from "../src/memory/record-candidates.ts";
import { MemoryStore } from "../src/memory/store.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

const session = (n: number) => captureSessionKey(`session-${n}`)!, at = (n: number) => new Date(Date.parse("2026-11-11T00:00:00.000Z") + n * 1000).toISOString();
function row(id: number, excerpt: string, extra: Partial<CaptureRow> = {}): CaptureRow {
  const anchors = /^amem: [^|]+ \| ([^|]+) \|/.exec(excerpt)?.[1]?.trim() ?? "-";
  return { id, at: at(id), project: "project", agent: "claude", event: "Record", tool: null, status: null,
    paths: anchors === "-" ? [] : anchors.split(",").map(anchor => anchor.trim()), excerpt, session: session(id), ...extra };
}
const empty = { queued: new Set<string>(), reviewed: new Set<string>() };
const window = (rows: CaptureRow[], partial = false): RecordCandidateWindow => ({ rows, partial });

test("one candidate per eligible Record; subagent, malformed and rewritten rows yield none", () => {
  const rows = [
    row(1, "amem: decision | src/writer.ts | bounded writer lease avoids contention"),
    row(2, "amem: decision | src/writer.ts | bounded writer lease avoids contention", { subagent: true }),
    row(3, "amem: decision | src/writer.ts | space is dropped on the way in"),
    row(4, "amem: fix | src/writer.ts | a fix without its arrow"),
    row(5, "not a record at all"),
    row(6, "amem: decision | src/writer.ts | another project", { project: "elsewhere" }),
    row(7, "amem: finding | src/writer.ts | no session hash", { session: undefined }),
    row(8, "amem: decision | src/reader.ts#tail | anchors come from the line, not the stored paths"),
  ];
  // The row the window reads is one canonical line: a line a re-parse would rewrite is not the Record it was staged as.
  rows[2]!.excerpt = "amem: decision |  src/writer.ts  | space is dropped on the way in";
  // `paths` is suffix-truncated at 400 bytes, so anchors are read from the line and a short stored copy is not a mismatch.
  rows[7]!.paths = ["src/reader.ts"];
  const result = recordCandidates(window(rows), "project", empty);
  expect(result.proposals).toHaveLength(2);
  expect(result.counts).toEqual({ found: 2, grouped: 0, alreadyQueued: 0, alreadyReviewed: 0, excluded: 6, truncated: false });
  expect(result.proposals[0]!.input).toMatchObject({ kind: "memory", noteKind: "decision", text: "bounded writer lease avoids contention",
    about: ["path:src/writer.ts"], record: { anchors: ["src/writer.ts"] } });
  expect(result.proposals[0]!.input.record!.sources).toEqual([{ session: session(1), at: at(1), textHash: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
  expect(result.proposals[1]!.input.record!.anchors).toEqual(["src/reader.ts#tail"]);
});

test("two sessions with the same kind and anchors become one candidate citing both rows", () => {
  const rows = [
    row(2, "amem: fix | src/writer.ts#lease | the 25 ms budget is the real deadline -> keep it under 20 ms"),
    row(1, "amem: fix | src/writer.ts#lease | lease deadline exceeded -> shorten the lease"),
  ];
  const result = recordCandidates(window(rows), "project", empty);
  expect(result.proposals).toHaveLength(1);
  expect(result.counts.grouped).toBe(1);
  const input = result.proposals[0]!.input;
  // The window is newest first, so the candidate quotes the newest text and cites both rows behind it.
  expect(input).toMatchObject({ kind: "memory", noteKind: "finding", title: "fix: the 25 ms budget is the real deadline -> keep it under 20 ms", text: "the 25 ms budget is the real deadline -> keep it under 20 ms" });
  expect(input.record!.sources.map(source => source.at)).toEqual([at(2), at(1)]);
  expect(input.about).toEqual(["path:src/writer.ts", "symbol:lease@src/writer.ts"]);
});

test("two Records in one turn stay two sources, and an empty-anchor Record keys by its text", () => {
  const same = ["amem: decision | src/writer.ts | one turn, two lessons", "amem: decision | src/writer.ts | one turn, another lesson"];
  const turn = recordCandidates(window([row(1, same[0]!), row(2, same[1]!, { at: at(1) })]), "project", empty);
  expect(turn.proposals).toHaveLength(1);
  expect(turn.proposals[0]!.input.record!.sources).toHaveLength(2);   // same session and time, distinguished by the stored line

  // `-` anchors are decision/contract only, so grouping by kind alone would merge two unrelated lessons into one candidate.
  const empty1 = row(3, "amem: decision | - | the empty anchor rule keeps decisions apart");
  const empty2 = row(4, "amem: contract | - | the empty anchor rule keeps contracts apart");
  const separate = recordCandidates(window([empty1, empty2]), "project", empty);
  expect(separate.proposals).toHaveLength(2);
  expect(separate.proposals.map(proposal => proposal.input.record!.anchors)).toEqual([[], []]);
  const distinct = separate.proposals[0]!.input.record!.key !== separate.proposals[1]!.input.record!.key;
  expect(distinct).toBe(true);

  // The same empty-anchor text twice is the same lesson, so those two rows are one candidate citing both.
  const repeat = recordCandidates(window([row(5, "amem: decision | - | keep the grammar additive"), row(6, "amem: decision | - | keep the grammar additive")]), "project", empty);
  expect(repeat.proposals).toHaveLength(1);
  expect(repeat.proposals[0]!.input.record!.sources).toHaveLength(2);
});

test("a fail Record fills the symptom and the retry condition it recorded, leaving approach and cause to the reviewer", () => {
  const result = recordCandidates(window([row(1, "amem: fail | src/capture.ts | writer starved under load -> retry after the queue drains")]), "project", empty);
  expect(result.proposals[0]!.input).toMatchObject({ kind: "fail", approach: "", symptom: "writer starved under load", cause: "",
    retryWhen: "retry after the queue drains", evidenceRefs: ["src/capture.ts"], about: ["path:src/capture.ts"] });
});

test("a group key already queued or already decided is not proposed again, and a partial window is reported", () => {
  const rows = [row(1, "amem: decision | src/writer.ts | bounded writer lease"), row(2, "amem: decision | src/other.ts | bounded reader lease")];
  const queued = recordCandidates(window(rows), "project", { queued: new Set([recordCandidates(window(rows), "project", empty).proposals[0]!.input.record!.key]), reviewed: new Set() });
  expect(queued.proposals.map(proposal => proposal.input.record!.anchors[0])).toEqual(["src/other.ts"]);
  expect(queued.counts.alreadyQueued).toBe(1);
  const reviewed = recordCandidates(window(rows, true), "project", { queued: new Set(), reviewed: new Set(rows.map((_, index) => recordCandidates(window(rows), "project", empty).proposals[index]!.input.record!.key)) });
  expect(reviewed.proposals).toEqual([]);
  expect(reviewed.counts).toMatchObject({ alreadyReviewed: 2, truncated: true });
});

test("consolidate proposes Record candidates, queues them once and leaves curated memory alone", async () => {
  const f = fixture();
  f.stage(1, "amem: decision | src/writer.ts | bounded writer lease avoids contention");
  f.stage(2, "amem: decision | src/writer.ts | bounded writer lease avoids contention", { session: session(9) });
  f.stage(3, "amem: fix | src/writer.ts#lease | lease deadline exceeded -> shorten the lease");
  f.stage(4, "amem: fail | src/capture.ts | writer starved under load -> retry after the queue drains");
  const before = f.store.list({ project: f.project });
  const first = await f.run(), again = await f.run();
  expect(first.records).toMatchObject({ found: 4, queued: 3, grouped: 1, refused: 0, excluded: 0, truncated: false });
  expect(first.candidates.map(row => row.action).sort()).toEqual(["record:decision", "record:fail", "record:finding"]);
  expect(again.records).toMatchObject({ found: 4, queued: 0, alreadyQueued: 3, alreadyReviewed: 0 });
  expect(again.candidates).toEqual([]);
  expect(f.candidates.list({ project: f.project })).toHaveLength(3);
  expect(f.store.list({ project: f.project })).toEqual(before);
});

test("accepting a fix and a fail Record candidate writes the decided kind and a labelled fail note", async () => {
  const f = fixture();
  f.stage(1, "amem: fix | src/writer.ts#lease | lease deadline exceeded -> shorten the lease");
  f.stage(2, "amem: fail | src/capture.ts | writer starved under load -> retry after the queue drains");
  const report = await f.run();
  const fix = report.candidates.find(row => row.action === "record:finding")!.id, fail = report.candidates.find(row => row.action === "record:fail")!.id;
  const fixed = f.candidates.accept(fix, f.acceptance);
  const note = f.store.get(fixed.noteId, f.project)!;
  expect(note.kind).toBe("finding");
  expect(note.title).toBe("fix: lease deadline exceeded -> shorten the lease");
  expect(note.about).toContain("path:src/writer.ts");
  expect(note.about).toContain("symbol:lease@src/writer.ts");

  const failed = f.candidates.accept(fail, f.acceptance), body = f.store.get(failed.noteId, f.project)!;
  expect(body.kind).toBe("fail");
  const labels = ["Approach: ", "Symptom: writer starved under load", "Cause: ", "Evidence: src/capture.ts", "Retry when: retry after the queue drains"];
  expect(labels.every(label => body.text.includes(`${label}\n`) || body.text.endsWith(label))).toBe(true);
  expect(body.about).toEqual(["path:src/capture.ts"]);
});

test("acceptance refuses with a named next step when the quoted row changed or was pruned", async () => {
  const f = fixture();
  f.stage(1, "amem: decision | src/writer.ts | bounded writer lease avoids contention");
  const [queued] = (await f.run()).candidates;
  f.rewrite(1, "amem: decision | src/writer.ts | bounded writer leases now share one deadline");
  expect(() => f.candidates.accept(queued!.id, f.acceptance)).toThrow("record source row changed since this candidate was queued; rerun `amem consolidate`");

  const second = fixture();
  second.stage(1, "amem: decision | src/writer.ts | bounded writer lease avoids contention");
  const [again] = (await second.run()).candidates;
  second.prune(1);
  expect(() => second.candidates.accept(again!.id, second.acceptance)).toThrow("record source row is missing (1 cited, pruned or forgotten from capture); reject this candidate");
});

test("a host with no capture read proposes no Record candidate and still consolidates", async () => {
  const f = fixture();
  f.stage(1, "amem: decision | src/writer.ts | bounded writer lease avoids contention");
  const report = await f.run({ records: undefined });
  expect(report.records).toBeUndefined();
  expect(f.candidates.list({ project: f.project })).toEqual([]);
});

test("recordSourceCheck asks only for the cited turns and answers from them", () => {
  const rows = [row(1, "amem: decision | src/writer.ts | bounded writer lease avoids contention")];
  const proposal = recordCandidates(window(rows), "project", empty).proposals[0]!;
  const asked: unknown[] = [];
  const check = recordSourceCheck((project, turns) => { asked.push({ project, turns }); return rows; });
  expect(check("project", proposal.input.record!)).toBe("present");
  // The window is never consulted: the check names the cited turn itself, so 32 newer Records cannot hide this one.
  expect(asked).toEqual([{ project: "project", turns: [{ session: session(1), at: at(1) }] }]);
  expect(recordSourceCheck(() => [])("project", proposal.input.record!)).toBe("missing");
  expect(recordSourceCheck(() => [row(1, "amem: decision | src/writer.ts | another lesson")])("project", proposal.input.record!)).toBe("changed");
});

test("a realistic volume proposes across sessions and acceptance outlives the brief window", async () => {
  const f = fixture();
  let n = 0;
  // Nine Records older than the window, then thirty inside it spread over four sessions (one path each, so one group
  // each), then the two shapes a person cares about: an empty-anchor decision and a fail with a recorded retry condition.
  for (let i = 0; i < 9; i++) f.stage(++n, `amem: decision | src/older-${i}.ts | older lesson ${i} stays outside the window`);
  for (let i = 0; i < 30; i++) f.stage(++n, `amem: decision | src/module-${i}.ts | lesson ${i} keeps the writer lease inside its budget`, { session: session(1 + i % 4) });
  f.stage(++n, "amem: decision | - | an empty anchor record keeps its own text");
  f.stage(++n, "amem: fail | src/capture.ts | writer starved under load -> retry after the queue drains");
  const report = await f.run();
  expect(report.records).toMatchObject({ found: 32, queued: 32, grouped: 0, refused: 0, excluded: 0, truncated: true });

  const inputOf = (id: string) => f.candidates.get(id, f.project)!.input;
  const fail = inputOf(report.candidates.find(row => row.action === "record:fail")!.id);
  expect(fail).toMatchObject({ kind: "fail", approach: "", symptom: "writer starved under load", cause: "", retryWhen: "retry after the queue drains" });
  const anchored = report.candidates.map(row => inputOf(row.id)).filter(input => input.kind === "memory" || input.kind === "fail")
    .filter(input => input.record!.anchors.length === 0);
  expect(anchored).toHaveLength(1);
  expect(anchored[0]).toMatchObject({ kind: "memory", text: "an empty anchor record keeps its own text" });

  // The oldest row inside the window is what a window-based recheck would lose first.
  const oldest = f.candidates.list({ project: f.project, limit: 500 }).find(candidate => {
    const input = candidate.input;
    return (input.kind === "memory" || input.kind === "fail") && input.record?.sources.some(source => source.at === at(10)) === true;
  })!;
  for (let i = 0; i < 33; i++) f.stage(++n, `amem: finding | src/later-${i}.ts | later lesson ${i} arrives after the candidate was queued`);
  expect(f.capture.readBriefRecords(32).rows.some(row => row.at === at(10))).toBe(false);

  // The row is out of the brief window and still in capture, so acceptance must read it as present, not as pruned.
  const accepted = f.candidates.accept(oldest.id, f.acceptance);
  expect(accepted.alreadyAccepted).toBe(false);
  expect(f.store.get(accepted.noteId, f.project)!.text).toContain("lesson 0 keeps the writer lease inside its budget");
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amem-record-candidates-")), project = "project";
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  let now = Date.parse("2026-11-11T00:00:00.000Z");
  const store = new MemoryStore({ memoryDir: root, deferPromotions: true, screen: () => "promote", now: () => now++ }),
    candidates = new CandidateStore({ memoryDir: root }), capture = new CaptureStore({ memoryDir: root, project });
  cleanup.push(() => store.close(), () => candidates.close(), () => capture.close());
  const ids = new Map<number, number>(), read = () => capture.readBriefRecords();
  const edit = (sql: string, ...values: (string | number)[]) => { const db = new Database(join(capture.dir, "capture.db")); try { db.query(sql).run(...values); } finally { db.close(); } };
  const options: ConsolidationOptions = { project, actor: "person", policy: () => createStandalonePolicy(), policyVersion: () => "fixed" };
  const acceptance = { project, actor: "person" as const, verdict: "public" as const, store, policy: () => true,
    recordSource: recordSourceCheck(recordCaptureLookup(root, root)) };
  return { root, project, store, candidates, capture, acceptance,
    stage(n: number, excerpt: string, extra: { session?: string } = {}) {
      const anchors = /^amem: [^|]+ \| ([^|]+) \|/.exec(excerpt)![1]!.trim();
      const result = capture.append({ project, agent: "claude", event: "Record", excerpt, paths: anchors === "-" ? [] : anchors.split(",").map(anchor => anchor.trim()),
        at: at(n), session: extra.session ?? session(n) });
      if (!("id" in result)) throw new Error("fixture staging spooled instead of writing");
      ids.set(n, result.id);
    },
    rewrite(n: number, excerpt: string) { edit("UPDATE rows SET excerpt = ? WHERE id = ?", excerpt, ids.get(n)!); },
    prune(n: number) { edit("DELETE FROM rows WHERE id = ?", ids.get(n)!); },
    run(extra: Partial<ConsolidationOptions> = {}) {
      return proposeConsolidation(store, candidates, { ...options, records: read, ...extra });
    },
  };
}

// A pruned row must also disappear from the window the acceptance recheck reads, so the two agree.
test("a pruned row is gone from the read-only window the acceptance recheck opens", () => {
  const f = fixture();
  f.stage(1, "amem: decision | src/writer.ts | bounded writer lease avoids contention");
  expect(f.capture.readBriefRecords().rows).toHaveLength(1);
  f.prune(1);
  const reopened = new CaptureStore({ memoryDir: f.root, project: f.project, readOnly: true, recentReadRows: true, maxReadRows: 32 });
  try { expect(reopened.readBriefRecords().rows).toEqual([]); } finally { reopened.close(); }
  // The candidate input stays JSON round-trippable: a binding is stored with the candidate, not inferred at acceptance.
  const proposal = recordCandidates(window([row(1, "amem: decision | src/writer.ts | bounded writer lease avoids contention")]), "project", empty).proposals[0]!.input;
  const stored = JSON.parse(JSON.stringify(proposal)) as { record?: { sources: unknown[] } };
  expect(stored.record!.sources).toHaveLength(1);
});
