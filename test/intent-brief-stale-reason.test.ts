import { expect, test } from "bun:test";
import { buildIntentBrief, type IntentBriefOptions } from "../src/memory/intent-brief.ts";
import { createStandalonePolicy } from "../src/memory/policy.ts";
import type { View } from "../src/memory/store.ts";

const at = "2026-10-24T00:00:00.000Z";
const view: View = { id: "a".repeat(32), at, machine: "b".repeat(16), project: "project", scope: "project", tier: "long", kind: "decision", peer: "person", title: null, text: "synthetic decision", task: null, about: ["path:public.ts"], source: "person", supersededBy: null, supersedes: [], promotedFrom: null, expiresAt: null, local: false };
test("brief stale reasons use bounded short codes and retain the byte limit", async () => {
  for (const [reason, marker] of [["missing_in_checkout", "(stale? missing)"], ["mtime_newer_than_note", "(stale? mtime)"]] as const) {
    const stale = Object.assign(() => true, { reason: () => reason });
    const options: IntentBriefOptions = { project: "project", cwd: "/unopened/repo", repo: "fixture", intent: "decision", paths: ["public.ts"], maxBytes: 1024, policy: () => createStandalonePolicy(), policyVersion: () => "fixed", now: () => Date.parse("2026-10-25T00:00:00.000Z"), stale };
    const result = await buildIntentBrief({ notes: () => [view] }, options);
    expect(result.text).toContain(marker); expect(result.bytes).toBe(Buffer.byteLength(result.text)); expect(result.bytes).toBeLessThanOrEqual(1024);
    expect(result.text).not.toContain(reason);
  }
});
