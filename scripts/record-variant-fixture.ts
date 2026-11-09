import { createHash } from "node:crypto";
import { createReadStream, openSync, closeSync, writeSync, statSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseRecordLines, type ParsedRecord } from "../src/hook-record.ts";
import { looksSecret } from "../src/memory/screen.ts";
import { readLongMemEvalQuestions, type LongMemEvalQuestion, type LongMemEvalTurn } from "./longmemeval-input.ts";

const FIXTURE_ANCHOR = /^fixtures\/longmemeval\.txt#s(0|[1-9]\d*)t(0|[1-9]\d*)$/;
const CANONICAL_LINE = /^amem: finding \| (fixtures\/longmemeval\.txt#s(?:0|[1-9]\d*)t(?:0|[1-9]\d*)) \| (.+)$/u;
const RULE = "Select up to two source-order has_answer=true turns in answer_session_ids for non-abstention questions; insert one false assistant fixture after each if its source-only normalized fact parses and passes the secret screen; retain all original turns in order.";

function sourceFact(content: string): string | undefined {
  const normalized = content.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\s]+/gu, " ").trim();
  if (!normalized) return undefined;
  const fact = Array.from(normalized).slice(0, 225).join("").trim();
  if (!fact || looksSecret(fact) || parseRecordLines(`amem: finding | fixtures/longmemeval.txt#s0t0 | ${fact}`).records.length !== 1) return undefined;
  return fact;
}

export function deriveRecordQuestion(q: LongMemEvalQuestion): { question: LongMemEvalQuestion; records: number; skipped: number } {
  const selected = new Set(q.answer_session_ids);
  const sessions = q.haystack_sessions.map(session => session.map(turn => ({ ...turn })));
  let records = 0, skipped = 0;
  if (!q.question_id.includes("_abs")) {
    for (let sessionIndex = 0; sessionIndex < q.haystack_sessions.length && records < 2; sessionIndex++) {
      if (!selected.has(q.haystack_session_ids[sessionIndex]!)) continue;
      const original = q.haystack_sessions[sessionIndex]!;
      const derived: LongMemEvalTurn[] = [];
      for (let turnIndex = 0; turnIndex < original.length; turnIndex++) {
        const turn = original[turnIndex]!;
        derived.push({ ...turn });
        if (records >= 2 || turn.has_answer !== true) continue;
        const fact = sourceFact(turn.content);
        if (!fact) { skipped++; continue; }
        const line = `amem: finding | fixtures/longmemeval.txt#s${sessionIndex}t${turnIndex} | ${fact}`;
        derived.push({ role: "assistant", content: line, has_answer: false });
        records++;
      }
      sessions[sessionIndex] = derived;
    }
  }
  return { question: { ...q, haystack_sessions: sessions }, records, skipped };
}

export function fixtureRecord(turn: LongMemEvalTurn): ParsedRecord | undefined {
  if (turn.role !== "assistant") return undefined;
  const lines = turn.content.split("\n");
  if (lines.length !== 1) return undefined;
  const match = CANONICAL_LINE.exec(lines[0]!);
  if (!match || !FIXTURE_ANCHOR.test(match[1]!)) return undefined;
  const parsed = parseRecordLines(lines[0]!);
  const record = parsed.records.length === 1 ? parsed.records[0] : undefined;
  return record?.kind === "finding" && record.anchors.length === 1 && record.anchors[0] === match[1] ? record : undefined;
}

export function variantRecordLine(record: ParsedRecord, variant: "a" | "b", ordinal: number): string {
  const prefix = variant === "b" && ordinal % 2 === 1 ? "? " : "";
  const basis = variant === "b" ? "; basis:test" : "";
  return `amem: ${record.kind} | ${record.anchors.join(", ")} | ${prefix}${record.text}${basis}`;
}

function args(argv: string[]): { input: string; output: string; provenance: string } {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!["--input", "--output", "--provenance"].includes(key ?? "") || !value || value.startsWith("--") || values.has(key!)) throw new Error("expected --input FILE --output FILE --provenance FILE");
    values.set(key!, value);
  }
  if (values.size !== 3) throw new Error("expected --input FILE --output FILE --provenance FILE");
  return { input: values.get("--input")!, output: values.get("--output")!, provenance: values.get("--provenance")! };
}

async function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256"); let bytes = 0;
  for await (const chunk of createReadStream(path)) { hash.update(chunk); bytes += chunk.length; }
  return { sha256: hash.digest("hex"), bytes };
}

function writeAll(fd: number, text: string): void {
  const data = Buffer.from(text);
  let offset = 0;
  while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
}

async function main(): Promise<void> {
  const options = args(process.argv.slice(2));
  const sourceStat = statSync(options.input);
  if (!sourceStat.isFile() || options.input === options.output || options.input === options.provenance || options.output === options.provenance) throw new Error("input and outputs must be distinct files");
  const sourceIdentity = (path: string) => {
    const value = statSync(path, { bigint: true });
    return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(":");
  };
  const originalIdentity = sourceIdentity(options.input);
  const source = await hashFile(options.input);
  if (sourceIdentity(options.input) !== originalIdentity || BigInt(source.bytes) !== BigInt(sourceStat.size)) throw Object.assign(new Error("source changed during hash"), { causeClass: "source_changed" });
  const outputFd = openSync(options.output, "wx", 0o600);
  let provenanceFd: number | undefined;
  try {
    const derivedHash = createHash("sha256"); let derivedBytes = 0, questions = 0, records = 0, skipped = 0;
    const emit = (text: string) => { writeAll(outputFd, text); const bytes = Buffer.from(text); derivedHash.update(bytes); derivedBytes += bytes.length; };
    emit("[");
    for await (const q of readLongMemEvalQuestions(options.input)) {
      const derived = deriveRecordQuestion(q);
      emit(`${questions ? "," : ""}\n${JSON.stringify(derived.question)}`);
      questions++; records += derived.records; skipped += derived.skipped;
    }
    if (sourceIdentity(options.input) !== originalIdentity) throw Object.assign(new Error("source changed during derivation"), { causeClass: "source_changed" });
    if (questions) emit("\n");
    emit("]\n");
    closeSync(outputFd);
    const script = await hashFile(fileURLToPath(import.meta.url));
    const harness = createHash("sha256");
    for (const relative of ["scripts/record-variant-fixture.ts", "scripts/longmemeval-input.ts", "src/hook-record.ts", "src/memory/private-spans.ts", "src/memory/screen.ts"]) {
      const dependency = await hashFile(fileURLToPath(new URL(`../${relative}`, import.meta.url)));
      harness.update(`${relative}\0${dependency.sha256}\n`);
    }
    const provenance = { source: { sha256: source.sha256, bytes: source.bytes }, derived: { sha256: derivedHash.digest("hex"), bytes: derivedBytes }, script: { sha256: script.sha256 }, harnessDigest: harness.digest("hex"), counts: { questions, records, skippedFixtureCandidates: skipped }, rule: RULE };
    provenanceFd = openSync(options.provenance, "wx", 0o600);
    writeAll(provenanceFd, `${JSON.stringify(provenance, null, 2)}\n`);
    closeSync(provenanceFd); provenanceFd = undefined;
  } catch (error) {
    try { closeSync(outputFd); } catch {}
    if (provenanceFd !== undefined) try { closeSync(provenanceFd); } catch {}
    try { unlinkSync(options.output); } catch {}
    if (provenanceFd !== undefined) try { unlinkSync(options.provenance); } catch {}
    throw error;
  }
}

if (import.meta.main) main().catch(error => {
  const cause = error && typeof error === "object" && "causeClass" in error ? "source_changed" : error instanceof Error && error.message.includes("LongMemEval input:") ? "invalid_input" : error instanceof Error && /EEXIST|EACCES|ENOENT/.test(error.message) ? "file_io" : "fixture_derivation";
  const next = cause === "source_changed" ? "verify the input stayed unchanged, then retry" : cause === "invalid_input" ? "verify the input is a valid LongMemEval JSON array" : cause === "file_io" ? "check file paths and output permissions" : "inspect the fixture derivation contract and input eligibility";
  process.stderr.write(`record variant fixture failed; cause: ${cause}; nextstep: ${next}\n`);
  process.exitCode = 1;
});
