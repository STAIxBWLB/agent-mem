import { parseRecordLines, RECORD_INPUT_BYTES, type RecordIntakeRefusal, type ParsedRecordTurn } from "./hook-record.ts";
import type { IngestKind } from "./ingest.ts";

const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const textParts = (parts: unknown): string => typeof parts === "string" ? parts : Array.isArray(parts)
  ? parts.filter(part => object(part) && ["text", "output_text"].includes(part.type) && typeof part.text === "string").map(part => part.text).join("\n") : "";
const child = (row: Record<string, any>) => row.isSidechain === true || row.subagent === true
  || [row.agentId, row.agent_id, row.agentRunId].some(value => typeof value === "string" && value.length > 0);
export const nativeRecordId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256
  && value.trim() === value && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
export interface NativeRecordTurn {
  parsed: ParsedRecordTurn; at?: string; identity: string; start: number; end: number;
  sources: unknown[]; refusal?: RecordIntakeRefusal; header?: true;
}
export function recordMainHeader(kind: "codex" | "pi", raw: unknown): { main: boolean; child: boolean; session?: string } {
  if (!object(raw)) return { main: false, child: false };
  const meta = kind === "codex" && raw.type === "session_meta" ? raw.payload : kind === "pi" && raw.type === "session" ? raw : undefined;
  if (!object(meta)) return { main: false, child: false };
  const isChild = child(raw) || child(meta) || [meta.parent_thread_id, meta.subagent_role, meta.subagent_nickname, meta.parentSession].some(value => value != null && value !== "")
    || kind === "codex" && object(meta.source);
  const main = !isChild && nativeRecordId(meta.id) && (kind === "codex" ? ["cli", "vscode", "exec", "mcp"].includes(meta.source) : meta.version === 3);
  return { main, child: isChild, ...(nativeRecordId(meta.id) ? { session: meta.id } : {}) };
}
/**
 * Kimi 1.5 completes a step with `finishReason: "end_turn"`; `tool_use`, `error` and `interrupted` are the only other
 * values real wire files carry (669 local `agents/main/wire.jsonl` files read 2026-11-11), so `"completed"` never occurs.
 */
const kimiCompleted = (value: unknown): boolean => value === "end_turn";
interface OpenStep { id: string; start: number; end: number; sources: unknown[]; parts: unknown[]; at?: string; bytes: number; refusal?: RecordIntakeRefusal }
/** Positive native completion only. State is bounded to this new source window, never a historical backfill. */
export class IngestRecordReader {
  private step?: OpenStep;
  private message?: { raw: Record<string, any>; start: number; end: number; at?: string; permitted: boolean };
  constructor(private readonly kind: IngestKind) {}
  private turn(text: string, start: number, end: number, at: string | undefined, identity: string, sources: unknown[], refusal?: RecordIntakeRefusal, header?: true): NativeRecordTurn[] {
    if (!text.includes("amem:")) return [];
    return [{ parsed: parseRecordLines(text), start, end, at, identity, sources, ...(refusal ? { refusal } : {}), ...(header ? { header } : {}) }];
  }
  private finishStep(refusal?: RecordIntakeRefusal): NativeRecordTurn[] {
    const step = this.step; this.step = undefined;
    return step ? this.turn(textParts(step.parts), step.start, step.end, step.at, step.id, step.sources, step.refusal ?? refusal) : [];
  }
  private finishMessage(refusal?: RecordIntakeRefusal, proof?: { raw: unknown; end: number; at?: string }): NativeRecordTurn[] {
    const saved = this.message; this.message = undefined;
    if (!saved) return [];
    return this.turn(textParts(saved.raw.message.content), saved.start, proof?.end ?? saved.end, saved.at ?? proof?.at,
      saved.raw.message.id, [saved.raw, ...(proof ? [proof.raw] : [])], !saved.permitted ? "record_policy" : saved.at === undefined ? "record_timestamp" : refusal);
  }
  read(raw: Record<string, any>, start: number, end: number, at: string | undefined, permitted: boolean, protocol: string): NativeRecordTurn[] {
    if (this.kind === "kimi") return this.kimi(raw, start, end, at, permitted, protocol);
    if (child(raw)) return [];
    const message = this.kind === "codex" && raw.type === "response_item" ? raw.payload : this.kind === "pi" && raw.type === "message" ? raw.message : this.kind === "qwen" && raw.type === "assistant" ? raw.message : undefined;
    if (!object(message) || message.role !== (this.kind === "qwen" ? "model" : "assistant")) return [];
    if (this.kind === "codex" && (message.type !== "message" || message.phase !== "final_answer" || message.status !== undefined && message.status !== "completed")) return [];
    if (this.kind === "pi" && (!Array.isArray(message.content) || message.stopReason !== "stop" || message.isError === true || message.errorMessage)) return [];
    const parts = this.kind === "qwen" ? message.parts : message.content;
    if (this.kind === "qwen" && (typeof raw.sessionId !== "string" || raw.sessionId.includes("-agent-") || !Array.isArray(parts))) return [];
    if (Array.isArray(parts) && parts.some(part => object(part) && (part.functionCall || part.functionResponse || part.type === "toolCall" || part.type === "tool_use" || part.type === "tool_result"))) return [];
    const text = this.kind === "qwen" ? parts.filter((part: any) => part.thought !== true && typeof part.text === "string").map((part: any) => part.text).join("\n") : textParts(parts);
    const id = this.kind === "codex" ? message.id : raw.id ?? raw.uuid;
    const invalidIdentity = (this.kind === "pi" || id != null) && !nativeRecordId(id);
    return this.turn(text, start, end, at, nativeRecordId(id) ? id : String(start), [raw], !permitted ? "record_policy" : this.kind === "qwen" ? "finality-unavailable" : invalidIdentity ? "record_identity" : undefined,
      this.kind === "qwen" ? undefined : true);
  }
  private kimi(raw: Record<string, any>, start: number, end: number, at: string | undefined, permitted: boolean, protocol: string): NativeRecordTurn[] {
    if (raw.agentId !== "main") return [];
    if (raw.type === "context.append_message" && object(raw.message) && raw.message.role === "assistant") {
      const prior = this.finishMessage("finality-unavailable");
      if (raw.message.toolCalls?.length || raw.message.toolCallId || raw.message.partial === true || raw.message.isError === true) return prior;
      if (protocol !== "1.5" || !nativeRecordId(raw.message.id)) return [...prior, ...this.turn(textParts(raw.message.content), start, end, at, String(start), [raw], permitted ? "finality-unavailable" : "record_policy")];
      this.message = { raw, start, end, at, permitted }; return prior;
    }
    if (raw.type !== "context.append_loop_event" || !object(raw.event) || protocol !== "1.5") return [];
    const event = raw.event;
    if (event.type === "step.begin" && nativeRecordId(event.uuid)) {
      const prior = this.finishStep("finality-unavailable");
      this.step = { id: event.uuid, start, end, at, sources: [raw], parts: [], bytes: 0, ...(!permitted ? { refusal: "record_policy" as const } : at === undefined ? { refusal: "record_timestamp" as const } : {}) };
      return prior;
    }
    if (event.type === "step.end") {
      const out: NativeRecordTurn[] = [];
      if (this.step && event.uuid === this.step.id) {
        this.step.sources.push(raw); this.step.end = end; this.step.at = at ?? this.step.at;
        if (!permitted) this.step.refusal = "record_policy";
        else if (at === undefined) this.step.refusal ??= "record_timestamp";
        out.push(...this.finishStep(kimiCompleted(event.finishReason) ? undefined : "finality-unavailable"));
      }
      if (this.message && event.messageId === this.message.raw.message.id && nativeRecordId(event.uuid)) {
        out.push(...this.finishMessage(kimiCompleted(event.finishReason) && permitted ? undefined : permitted ? "finality-unavailable" : "record_policy", { raw, end, at }));
      }
      return out;
    }
    if (!this.step || event.stepUuid !== this.step.id) {
      return event.type === "content.part" && object(event.part) && event.part.type === "text"
        ? this.turn(textParts([event.part]), start, end, at, String(start), [raw], permitted ? "finality-unavailable" : "record_policy") : [];
    }
    this.step.end = end;
    if (!permitted) this.step.refusal = "record_policy";
    else if (at === undefined) this.step.refusal ??= "record_timestamp";
    if (event.type === "tool.call") this.step.refusal ??= "finality-unavailable";
    // ponytail: a native step is bounded to 256 KiB/4096 events in one forward window; persistent cross-window folding needs a separate bounded-state design.
    this.step.bytes += end - start;
    if (this.step.bytes > RECORD_INPUT_BYTES || this.step.sources.length >= 4096) return this.finishStep("record_length");
    this.step.sources.push(raw);
    if (event.type === "content.part" && object(event.part) && event.part.type === "text" && typeof event.part.text === "string") this.step.parts.push(event.part);
    return [];
  }
  get pendingStart(): number | undefined {
    const offsets = [this.step?.start, this.message?.start].filter((value): value is number => value !== undefined);
    return offsets.length ? Math.min(...offsets) : undefined;
  }
  finish(reason: RecordIntakeRefusal = "finality-unavailable"): NativeRecordTurn[] { return [...this.finishStep(reason), ...this.finishMessage(reason)]; }
}
