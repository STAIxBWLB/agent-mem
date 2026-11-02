import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stageHookCapture } from "../../src/hook-spool.ts";
import { normalizeCaptureFields, type NormalizedCaptureFields } from "../../src/memory/capture-input.ts";

/** Raw pre-quota publications exercise real global limits rather than silently evicting
 * the fixture through today's 64/8 admission shares. Future envelopes explicitly model
 * #199's protected unknown-schema backlog, not ordinary replayable capture. */
export async function seedHookBacklog(options: { cwd: string; base: string }, counts: { active: number; reserve?: number; futureSchema?: boolean; label: string }): Promise<void> {
  const reserveCount = counts.reserve ?? 0;
  if (!Number.isSafeInteger(counts.active) || counts.active < 0 || counts.active > 256 || !Number.isSafeInteger(reserveCount) || reserveCount < 0 || reserveCount > 32) throw Error("invalid hook backlog fixture bounds");
  const staged = await stageHookCapture("PostToolUse", { prompt: "backlog fixture template" }, options);
  if (!staged) throw Error("hook backlog fixture could not publish its template");
  const active = join(options.base, "hook-spool"), source = join(active, staged.name);
  const template = JSON.parse(readFileSync(source, "utf8")) as { capture: NormalizedCaptureFields };
  rmSync(source);
  const reserve = join(active, ".capacity");
  if (reserveCount) mkdirSync(reserve, { mode: 0o700 });
  for (let i = 0; i < counts.active + reserveCount; i++) {
    const { tool, status, ...fields } = template.capture;
    const capture = normalizeCaptureFields({ ...fields, excerpt: `${counts.label} ${i}`, ...(tool === null ? {} : { tool }), ...(status === null ? {} : { status }) });
    const nonce = i.toString(16).padStart(32, "0"), name = staged.name.replace(/[a-f0-9]{32}\.json$/, nonce + ".json");
    writeFileSync(join(i < counts.active ? active : reserve, name), JSON.stringify({ ...template, nonce, capture,
      ...(counts.futureSchema ? { schema: "agent-mem.hook-capture/v99" } : {}) }), { mode: 0o600, flag: "wx" });
  }
}
