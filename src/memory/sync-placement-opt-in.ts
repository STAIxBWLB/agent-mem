/**
 * #578 Q2 (owner choice c): the person-facing writer of the home opt-in for a sync-run placement checkpoint.
 * `amem migrate --sync-placement --checkpoint-on-bound on|off` previews by default; `--confirm` read-modify-writes the
 * machine `amem.config.json` in the memory home, preserving every other key, atomically and with mode 0600. A file that
 * does not parse, or that the config reader refuses, is never rewritten. Hand-editing `syncPlacement.checkpointOnBound`
 * stays valid; this command is only the reviewed way to change it. No actor gate (#431).
 */
import { closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { loadAmemConfig, machineConfigPath } from "./config.ts";

export interface CheckpointOnBoundOptInChange { file: string; current: boolean; target: boolean; written: boolean; text: string }

export function checkpointOnBoundOptInChange(home: string, target: boolean, confirm: boolean): CheckpointOnBoundOptInChange {
  const file = machineConfigPath(home);
  // The reader is the validator: an unknown key, a bad value, a link or an oversized file refuses before anything is written.
  const current = loadAmemConfig(home).config.syncPlacement?.checkpointOnBound === true;
  const command = `amem migrate --sync-placement --checkpoint-on-bound ${target ? "on" : "off"} --confirm`;
  if (!confirm) return { file, current, target, written: false,
    text: `sync-run placement checkpoint opt-in: ${current ? "on" : "off"} -> ${target ? "on" : "off"} in ${file}; preview only, run ${command} to write it` };
  if (current === target) return { file, current, target, written: false, text: `sync-run placement checkpoint opt-in: already ${target ? "on" : "off"}; nothing written` };
  let body: Record<string, unknown> = {};
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (stat) {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file}: is not a JSON object; nothing written`);
    body = parsed as Record<string, unknown>;
    if (typeof body.home === "string") throw new Error(`${file}: names a home, so it is only a pointer; set the opt-in in that home's config; nothing written`);
  }
  const prior = body.syncPlacement && typeof body.syncPlacement === "object" && !Array.isArray(body.syncPlacement) ? body.syncPlacement as Record<string, unknown> : {};
  const next = { ...body, syncPlacement: { ...prior, checkpointOnBound: target } };
  const temp = join(dirname(file), `.amem.config.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeSync(fd, JSON.stringify(next, null, 2) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, file);
  // Re-read through the validator so a written file is always one the reader accepts.
  if (loadAmemConfig(home).config.syncPlacement?.checkpointOnBound !== target) throw new Error(`${file}: the written opt-in did not read back`);
  return { file, current, target, written: true, text: `sync-run placement checkpoint opt-in: ${target ? "on" : "off"} written to ${file}` };
}
