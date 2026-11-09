import { RECORD_VARIANTS_FILE, RECORD_VARIANTS_MAX_BYTES, RECORD_VARIANTS_DAYS } from "../src/memory/record-variant-log.ts";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_BYTES = RECORD_VARIANTS_MAX_BYTES;
const VARIANTS = ["a", "b"] as const;
type Variant = typeof VARIANTS[number];
type Row = Record<string, unknown>;

const isObject = (value: unknown): value is Row => value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const ratio = (numerator: number, denominator: number): number | null => denominator === 0 ? null : numerator / denominator;

/** Aggregate only bounded numeric telemetry. Input rows and any text fields are never returned. */
export function aggregateRecordVariants(samples: unknown[]) {
  const empty = () => ({
    invalidInstructionSelections: 0, sessions: 0, disabledSessions: 0, instructionEmittedSessions: 0, turns: 0,
    observedTurns: 0, turnsWithRecords: 0, validRecords: 0, basisRecords: 0,
    unverifiedRecords: 0, briefBytes: 0, briefSamples: 0, incompleteRows: 0,
    sessionRows: 0, enabledRows: 0, instructionRows: 0, turnRows: 0,
    turnCounterRows: 0, turnsWithRecordsRows: 0, recordRows: 0,
    basisRows: 0, unverifiedRows: 0,
  });
  const totals = { a: empty(), b: empty() };
  let ignoredRows = 0, unknownRows = 0, malformedRows = 0, hookRows = 0, attributedRows = 0;
  let capForcedTrim = false;
  for (const original of samples) {
    const value = isObject(original) && (original.variant === "a" || original.variant === "b") && ["SessionStart", "Stop", "SessionEnd"].includes(original.event as string)
      ? { ...original, kind: "hook", recordVariant: original.variant } : original;
    if (isObject(value) && value.capTrimmed === 1) capForcedTrim = true;
    if (!isObject(value)) { malformedRows++; continue; }
    if (value.kind !== "hook") { ignoredRows++; continue; }
    hookRows++;
    if (value.recordVariant !== "a" && value.recordVariant !== "b") { unknownRows++; continue; }

    const delta = empty();
    let malformed = false, recognized = false, incomplete = false;
    attributedRows++;
    const add = (field: string, key: keyof typeof delta, rowsKey?: keyof typeof delta) => {
      if (!(field in value)) return;
      recognized = true;
      if (!count(value[field])) { malformed = true; return; }
      if ((field === "recordSessions" || field === "recordTurnsWithRecords") && value[field] > 1) { malformed = true; return; }
      delta[key] += value[field];
      if (rowsKey) delta[rowsKey]++;
    };
    add("recordSessions", "sessions", "sessionRows");
    if ("recordInstructionInvalid" in value) {
      recognized = true;
      if (!count(value.recordInstructionInvalid) || value.recordInstructionInvalid > 1) malformed = true;
      else delta.invalidInstructionSelections += value.recordInstructionInvalid;
    }
    if ("recordEnabled" in value) {
      recognized = true;
      if (!count(value.recordEnabled) || value.recordEnabled > 1) malformed = true;
      else {
        delta.enabledRows++;
        if (count(value.recordSessions) && value.recordEnabled === 0) delta.disabledSessions += value.recordSessions;
      }
    }
    if ("recordInstructionEmitted" in value) {
      recognized = true;
      if (!count(value.recordInstructionEmitted) || value.recordInstructionEmitted > 1) malformed = true;
      else {
        delta.instructionRows++;
        if (count(value.recordSessions) && value.recordInstructionEmitted === 1) delta.instructionEmittedSessions += value.recordSessions;
      }
    }
    add("recordBriefBytes", "briefBytes", "briefSamples");
    add("recordTurns", "turns");
    if ("recordTurns" in value && count(value.recordTurns)) {
      if (value.recordTurns === 1) {
        delta.turnRows++;
        if ("recordTurnsWithRecords" in value && (!count(value.recordTurnsWithRecords) || value.recordTurnsWithRecords > 1)) malformed = true;
        const turnCountsComplete = count(value.recordValidRecords) && count(value.recordBasisRecords) && count(value.recordUnverifiedRecords) && count(value.recordTurnsWithRecords) && value.recordTurnsWithRecords <= 1;
        if (turnCountsComplete) {
          delta.turnCounterRows++;
          delta.observedTurns++;
          add("recordTurnsWithRecords", "turnsWithRecords", "turnsWithRecordsRows");
        } else incomplete = true;
      }
      if (value.recordTurns !== 0 && value.recordTurns !== 1) malformed = true;
    }
    add("recordValidRecords", "validRecords", "recordRows");
    add("recordBasisRecords", "basisRecords", "basisRows");
    add("recordUnverifiedRecords", "unverifiedRecords", "unverifiedRows");
    const recordFields = ["recordValidRecords", "recordBasisRecords", "recordUnverifiedRecords"];
    const hasRecordFields = recordFields.some(field => field in value);
    if (hasRecordFields && !recordFields.every(field => field in value && count(value[field]))) incomplete = true;
    if ("recordTurns" in value && value.recordTurns === 0 && hasRecordFields && !recordFields.every(field => field in value && count(value[field]))) incomplete = true;
    if (incomplete) delta.incompleteRows++;
    if (!recognized) { totals[value.recordVariant].incompleteRows++; continue; }
    const current = totals[value.recordVariant];
    const next = { ...current };
    for (const key of Object.keys(delta) as Array<keyof typeof delta>) {
      const sum = current[key] + delta[key];
      if (!Number.isSafeInteger(sum)) malformed = true;
      next[key] = sum;
    }
    if (next.basisRecords > next.validRecords || next.unverifiedRecords > next.validRecords ||
      delta.basisRecords > delta.validRecords || delta.unverifiedRecords > delta.validRecords ||
      ("recordBasisRecords" in value && count(value.recordBasisRecords) && value.recordBasisRecords > (count(value.recordValidRecords) ? value.recordValidRecords : 0)) ||
      ("recordUnverifiedRecords" in value && count(value.recordUnverifiedRecords) && value.recordUnverifiedRecords > (count(value.recordValidRecords) ? value.recordValidRecords : 0)) ||
      (value.recordTurns === 1 && count(value.recordValidRecords) && count(value.recordTurnsWithRecords) &&
        ((value.recordValidRecords > 0 && value.recordTurnsWithRecords === 0) || (value.recordValidRecords === 0 && value.recordTurnsWithRecords > 0)))) malformed = true;
    if (malformed) { malformedRows++; continue; }
    Object.assign(current, next);
  }
  const variants = Object.fromEntries(VARIANTS.map(variant => {
    const x = totals[variant];
    const turnComplete = x.turnRows > 0 && x.turnCounterRows === x.turnRows && x.turnsWithRecordsRows === x.turnRows;
    return [variant, {
      invalidInstructionSelections: x.invalidInstructionSelections,
      sessions: x.sessionRows ? x.sessions : null,
      recordsPerSession: x.recordRows && x.sessionRows ? ratio(x.validRecords, x.sessions) : null,
      turns: x.turnRows ? x.turns : null,
      observedTurns: x.observedTurns || null,
      turnsWithRecords: x.turnsWithRecordsRows ? x.turnsWithRecords : null,
      turnShare: turnComplete ? ratio(x.turnsWithRecords, x.turns) : null,
      observedShare: ratio(x.turnsWithRecords, x.observedTurns),
      validRecords: x.recordRows ? x.validRecords : null,
      basisShare: x.recordRows && x.basisRows === x.recordRows ? ratio(x.basisRecords, x.validRecords) : null,
      unverifiedShare: x.recordRows && x.unverifiedRows === x.recordRows ? ratio(x.unverifiedRecords, x.validRecords) : null,
      meanBriefBytes: x.briefSamples ? ratio(x.briefBytes, x.briefSamples) : null,
      disabledSessions: x.enabledRows ? x.disabledSessions : null,
      instructionEmittedSessions: x.instructionRows ? x.instructionEmittedSessions : null,
      denominatorCounts: { sessions: x.sessionRows ? x.sessions : null, allStopTurns: x.turns, observedStopTurns: x.observedTurns, validRecords: x.recordRows ? x.validRecords : null, briefSamples: x.briefSamples },
      denominators: { recordsPerSession: "validRecords / sessions", turnShare: "turnsWithRecords / turns; null when Stop counters are incomplete", observedShare: "known turnsWithRecords / observedTurns", basisShare: "basisRecords / validRecords", unverifiedShare: "unverifiedRecords / validRecords", meanBriefBytes: "sum(recordBriefBytes) / samples containing recordBriefBytes" },
    }];
  }));
  const incompleteRows = totals.a.incompleteRows + totals.b.incompleteRows;
  const totalRows = samples.length;
  return { variants, ignoredRows, unknownRows, malformedRows, incompleteRows,
    window: { file: RECORD_VARIANTS_FILE, retentionDays: RECORD_VARIANTS_DAYS, capBytes: RECORD_VARIANTS_MAX_BYTES, capForcedTrim },
    scanCoverage: { totalRows, hookRows, attributedRows, complete: !capForcedTrim && totalRows > 0 && unknownRows === 0 && malformedRows === 0 && incompleteRows === 0, unknownRows, malformedRows, incompleteRows, ignoredRows },
    retention: "Record observations retain 8 days within a 4 MiB cap; capForcedTrim means the supplied window lost observations." };
}

function readMetrics(file: string): unknown[] {
  let fd: number | undefined;
  try {
    const link = lstatSync(file);
    if (link.isSymbolicLink()) throw new Error("symlink");
    if (!link.isFile()) throw new Error("not-file");
    if (link.size > MAX_BYTES) throw new Error("too-large");
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("not-file");
    if (stat.size > MAX_BYTES) throw new Error("too-large");
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    if (length > MAX_BYTES) throw new Error("too-large");
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
    const rows: unknown[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { rows.push(undefined); }
    }
    return rows;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error("Cannot read metrics file. Next step: provide an existing metrics file.");
    const reason = (error as Error).message;
    if (reason === "too-large") throw new Error("Record variant journal exceeds the 4 MiB limit. Next step: inspect the writer cap and supply a bounded journal.");
    if (reason === "symlink") throw new Error("Metrics path is a symlink. Next step: provide a regular metrics file.");
    if (reason === "not-file") throw new Error("Metrics path is not a regular file. Next step: provide a regular metrics file.");
    throw new Error("Metrics file cannot be read. Next step: check file permissions and encoding.");
  } finally { if (fd !== undefined) closeSync(fd); }
}

function main(args: string[]): void {
  if (args.length !== 2 || !["--input", "--metrics"].includes(args[0]!) || !args[1]) {
    console.error("Invalid report arguments; use bun scripts/report-record-variants.ts --input record-variants.jsonl"); process.exitCode = 2; return;
  }
  try {
    const samples = readMetrics(args[1]);
    const report = aggregateRecordVariants(samples);
    if (samples.length === 0) {
      console.error("Metrics file contains no rows. Next step: provide a nonempty JSONL metrics file."); process.exitCode = 1; return;
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) { console.error((error as Error).message); process.exitCode = 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2));
