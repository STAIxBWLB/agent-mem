/**
 * Console plugin for acon (STAIxBWLB/agent-console contract api 1; UX per STAIxBWLB/vault-mem#48), agent-mem#158.
 * Reads go through the screened MCP read handlers in process, so the console sees what an MCP client of that project sees.
 * Review writes run the same library calls as `amem review accept|reject` and `review walk`'s edit, stamped as the person.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createMemoryMcp } from "../mcp-memory.ts";
import { MCP_TOOLS } from "../mcp.ts";
import { CandidateStore, type Candidate, type CandidateInput } from "../memory/candidates.ts";
import { candidateOverlapsBatch } from "../memory/candidate-overlaps.ts";
import { capacityReport } from "../memory/capacity.ts";
import { readCaptureConfigFile, writeCaptureConfigFile } from "../memory/capture.ts";
import { readCatalogFresh } from "../memory/catalog.ts";
import { configuredPolicy, configuredPolicyOptions } from "../memory/config.ts";
import { openCuratedForRead, requireShard } from "../memory/curated-read.ts";
import { applyDecay, assertExactDecayForget, decayPreview, DECAY_DEFAULT_DAYS, readDecayCounters } from "../memory/decay-review.ts";
import { gcText, runGc } from "../memory/gc.ts";
import { memoryHome } from "../memory/home.ts";
import { appendLifecycle, assertProjectActive, projectState } from "../memory/lifecycle.ts";
import { hasFailLabel, noteAdd, parseFailTemplate } from "../memory/note-add.ts";
import type { StandalonePolicy } from "../memory/policy.ts";
import { applyPrune, planPrune, pruneText } from "../memory/prune.ts";
import { aliasedKeys, readShardedSelection, resolveAlias } from "../memory/shard.ts";
import { machineId, MemoryStore, openShardStore, type StoreOptions, type View } from "../memory/store.ts";

// The contract types this module uses, copied from agent-console src/contract.ts (api 1, additive only): src/ takes no
// package imports. test/ui-plugin.test.ts type-checks the plugin against the real contract and runs its conformance suite.
type Args = Record<string, unknown>;
interface Change { op: "create" | "modify" | "delete" | "log"; target: string; note?: string }
type ActionResult =
  | ({ ok: true; message?: string; undo?: { action: string } & Args } & Args)
  | { ok: false; error: string }
  | { ok: false; needsConfirm: true; preview: string[]; fingerprint: string; verb?: string; changes?: Change[]; warnings?: string[] };
interface InboxItem {
  id: string; group: "candidate" | "alert"; kind: string; title: string; detail?: string; project?: string; at: string;
  chip?: { text: string; tone: "ok" | "warn" | "err" | "neutral" };
  verbs: { id: string; label: string; primary?: boolean; reason?: "optional" | "required" }[];
  link: { panel: string; params?: Record<string, string> };
}
interface Provider {
  assets: { js: string; css?: string };
  snapshot(input: { after: number; panel: string } & Args): Promise<Args>;
  action(input: { action: string; confirmed?: true; fingerprint?: string } & Args): Promise<ActionResult>;
}
type Preview = { verb: string; preview: string[]; changes: Change[]; warnings?: string[] };
type Found = { id: string; project: string; candidate: Candidate };

const asset = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");
const VERSION = (JSON.parse(asset("../../package.json")) as { version: string }).version;
/** agent-mem#143: actions from the console are the person's; the console is never an agent session's surface. */
const ACTOR = "person" as const;
const UNDO_MS = 60_000;
const ACTIONS = ["accept", "reject", "edit_accept", "accept_undo", "reject_undo", "gc", "capacity_apply", "project_forget", "decay_apply", "prune"];
const str = (v: unknown): string | undefined => typeof v === "string" && v.trim() ? v : undefined;
const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0]!;
const oneLine = (text: string, max = 160) => { const flat = text.replace(/\s+/g, " ").trim(); return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat; };

/** What a candidate proposes, as text. */
export function candidateText(input: CandidateInput): string {
  switch (input.kind) {
    case "memory": return input.title ? `${input.title}: ${input.text}` : input.text;
    case "fail": return `Approach: ${input.approach}\nSymptom: ${input.symptom}\nCause: ${input.cause}\nRetry when: ${input.retryWhen}`;
    case "correction": return `${input.proposedText}\n\nReason: ${input.reason}`;
    case "decay": return input.reason;
    case "promotion": return `Promote mem:${input.target.id} to long-term for goal:${input.goalId}`;
    case "consolidation": return `${input.action}: ${input.text}`;
    case "model-answer": return input.text;
  }
}
/** The text `review walk`'s edit opens for a memory or fail candidate. */
function editText(input: CandidateInput): string | null {
  if (input.kind === "fail") return `Approach: ${input.approach}\nSymptom: ${input.symptom}\nCause: ${input.cause}\nEvidence: ${input.evidenceRefs.join(", ")}\nRetry when: ${input.retryWhen}\n`;
  if (input.kind !== "memory") return null;
  return input.noteKind === "fail" && !hasFailLabel(input.text) ? `Approach: ${input.text}\nSymptom: \nCause: \nEvidence: \nRetry when: \n` : input.text;
}
const targetsOf = (input: CandidateInput) => "targets" in input ? input.targets : "target" in input && input.target ? [input.target] : [];

/** The CLI's curatedStore on an explicit home (src/cli.ts keeps its own copy; cli.ts is not a library module). */
function openCurated(base: string, project: string, opts: StoreOptions, reconciled = true): MemoryStore {
  assertProjectActive(base, project);
  const aliases = reconciled ? aliasedKeys(base, project) : [];
  const withAliases: StoreOptions = aliases.length ? { ...opts, reconcile: { canonical: project, aliases } } : opts;
  if (existsSync(join(base, "shards.json"))) { readShardedSelection(base); return openShardStore({ ...withAliases, memoryDir: base, project }); }
  return new MemoryStore({ ...withAliases, memoryDir: base });
}

/** A refusal that names which part of the screen declined, never the text. */
function refusal(value: unknown, policy: StandalonePolicy): ActionResult {
  let personal = false;
  try { personal = policy.declinesPersonal(JSON.stringify(value)); } catch { /* unreadable: reported as unscreenable */ }
  return { ok: false, error: `Refused by the privacy screen: ${personal ? "personal data, a configured PII pattern or a deny path" : "a likely secret, or a value the screen cannot read"}. Nothing was written.` };
}

export const plugin = {
  manifest: {
    api: 1 as const, tool: "amem", version: VERSION, title: "Memory", icon: "memory", pollMs: 15_000,
    panels: [
      { id: "review", title: "Review", order: 1 },
      { id: "find", title: "Search", order: 2 },
      { id: "timeline", title: "Timeline", order: 3 },
      { id: "work", title: "Work lists", order: 4 },
      { id: "goals", title: "Goals", order: 5 },
      { id: "capacity", title: "Capacity", order: 6 },
    ],
    commands: [
      { id: "gc", title: "Evict expired capture rows", hint: "amem gc", action: "gc" },
      { id: "capacity-apply", title: "Apply the capture capacity proposal", hint: "amem capacity apply", action: "capacity_apply" },
    ],
    capabilities: { actions: ACTIONS, confirm: true, multiProject: true, inbox: true, search: true },
  },
  async open(ctx: { home: string; log(line: string): void }): Promise<Provider> {
    const base = memoryHome({ ...process.env, AGENTHUB_HOME: ctx.home });
    // The machine policy of this home. The console runs in no repository, so a repository's `.amem/config` narrowing does not apply here.
    const policy = () => configuredPolicy(base);
    const policyVersion = () => JSON.stringify(configuredPolicyOptions(base));
    const hasCandidates = () => existsSync(join(base, "candidates.db"));
    const withCandidates = <T>(project: string | undefined, run: (store: CandidateStore) => T): T => {
      const aliases = project ? aliasedKeys(base, project) : [];
      const store = new CandidateStore({ memoryDir: base, ...(project && aliases.length ? { reconcile: { canonical: project, aliases } } : {}) });
      try { return run(store); } finally { store.close(); }
    };

    // ponytail: the catalog scan walks every shard on each snapshot; cache it by shard mtimes if polls get slow on a large home.
    function projects(): string[] {
      if (!existsSync(base)) return [];
      const keys = new Set<string>(), waiting = new Set<string>();
      try { for (const p of readCatalogFresh(base)) keys.add(p.key); } catch (e) { ctx.log(`amem: project catalog unavailable: ${errorText(e)}`); }
      if (hasCandidates()) for (const key of withCandidates(undefined, store => store.projects())) { const canonical = resolveAlias(base, key); keys.add(canonical); waiting.add(canonical); }
      return [...keys].filter(key => projectState(base, key) === "active").sort((a, b) => Number(waiting.has(b)) - Number(waiting.has(a)) || a.localeCompare(b));
    }
    // The shell's tabs navigate without params, so the project chosen on one panel is kept for the others and the palette.
    // ponytail: one choice per provider; fine for H0's single person, per session once a console serves several.
    let chosen: string | undefined;
    const pick = (args: Args, list: string[]) => {
      const asked = str(args.project);
      if (asked && list.includes(resolveAlias(base, asked))) chosen = resolveAlias(base, asked);
      return chosen && list.includes(chosen) ? chosen : list[0];
    };

    /** Every option the MCP tool declares is forwarded; nothing is hand-picked. The handler validates and refuses as it does for MCP. */
    const forward = (tool: "amem_search" | "amem_timeline" | "amem_work_state_read", args: Args): Args => {
      const schema = MCP_TOOLS.find(t => t.name === tool)!.inputSchema as { properties: Record<string, { type?: string }> };
      const out: Args = {};
      for (const [key, spec] of Object.entries(schema.properties)) {
        let value = args[key];
        if (value === undefined || value === "") continue;
        if (spec.type === "integer" && typeof value === "string" && /^[0-9]+$/.test(value)) value = Number(value);
        if (spec.type === "boolean" && (value === "true" || value === "false")) value = value === "true";
        out[key] = value;
      }
      return out;
    };
    async function read(project: string, tool: "amem_search" | "amem_timeline" | "amem_work_state_read", args: Args): Promise<unknown> {
      const mcp = createMemoryMcp({ cwd: base, base, project });
      try { return await mcp.tools[tool](forward(tool, args)); } finally { mcp.close(); }
    }

    /** The CLI's rule for agent-marked review, applied to the person here: the console shows only what passes the screen, targets included. */
    const visible = (candidate: Candidate, project: string, store: MemoryStore | undefined, p: StandalonePolicy): boolean => {
      if (!p.screenStandalone(candidate)) return false;
      const input = candidate.input, targets = targetsOf(input);
      if (!targets.length && input.kind !== "promotion") return true;
      if (!store) return false;
      if (targets.some(t => { const view = store.get(t.id, project); return !view || view.project !== project || !p.screenStandalone(view); })) return false;
      if (input.kind === "promotion") { const goal = store.goalOf(input.goalId, project); if (!goal || !p.screenStandalone(goal)) return false; }
      return true;
    };
    const projectOf = new Map<string, string>();
    async function pending(project: string, detail: boolean) {
      if (!hasCandidates()) return { rows: [], hidden: 0 };
      const p = policy(), store = openCuratedForRead(base, project);
      try {
        const all = withCandidates(project, c => c.list({ project, status: "pending" }));
        const shown = all.filter(c => visible(c, project, store, p));
        for (const c of shown) projectOf.set(c.id, project);
        const overlaps = detail && store ? await candidateOverlapsBatch(shown, store, { project, policy, policyVersion }) : [];
        const rows = shown.map((c, index) => {
          const input = c.input;
          const targets = targetsOf(input).map(t => { const v = store?.get(t.id, project); return v ? { id: v.id, at: v.at, kind: v.kind, title: v.title, text: v.text } : { id: t.id }; });
          return {
            id: c.id, kind: input.kind, createdAt: c.createdAt, text: candidateText(input),
            noteKind: "noteKind" in input ? input.noteKind ?? null : null,
            diff: input.kind === "correction" ? { now: (targets[0] as { text?: string } | undefined)?.text ?? null, proposed: input.proposedText, reason: input.reason } : null,
            evidence: input.kind === "fail" ? input.evidenceRefs : [],
            targets, overlaps: overlaps[index] ?? [],
            acceptable: input.kind !== "decay" && input.kind !== "model-answer",
            edit: editText(input),
          };
        });
        return { rows, hidden: all.length - shown.length };
      } finally { store?.close(); }
    }

    async function capacity() {
      if (!existsSync(base)) return undefined;
      const report = capacityReport({ memoryDir: base });
      if (!await policy().screen(report)) return { withheld: true as const };
      return { report, applyNeeded: report.current.capMb !== report.proposal.capMb || report.current.retentionDays !== report.proposal.retentionDays };
    }
    // The shell keys snooze and oldest-first order on `at`: an alert keeps the time it was first seen.
    const firstSeen = new Map<string, string>();
    const since = (id: string) => { const at = firstSeen.get(id) ?? new Date().toISOString(); firstSeen.set(id, at); return at; };
    async function inbox(): Promise<InboxItem[]> {
      const items: InboxItem[] = [];
      for (const project of projects()) {
        for (const row of (await pending(project, false)).rows) items.push({
          id: row.id, group: "candidate", kind: row.kind, title: oneLine(row.text, 120), detail: `${row.kind} candidate in ${project}`, project, at: row.createdAt,
          verbs: [...row.acceptable ? [{ id: "accept", label: "Accept", primary: true }] : [], { id: "reject", label: "Reject", reason: "optional" as const }],
          link: { panel: "review", params: { project, id: row.id } },
        });
      }
      const cap = await capacity();
      if (cap && "report" in cap && cap.applyNeeded) {
        const { current, proposal } = cap.report;
        items.push({ id: "capacity:proposal", group: "alert", kind: "capacity", title: `Capture capacity: ${current.capMb} MB / ${current.retentionDays} d, proposed ${proposal.capMb} MB / ${proposal.retentionDays} d`,
          detail: proposal.reason, at: since("capacity:proposal"), chip: { text: "proposal", tone: "warn" }, verbs: [{ id: "capacity_apply", label: "Apply..." }], link: { panel: "capacity" } });
      } else firstSeen.delete("capacity:proposal");
      return items;
    }

    function searchHit(hit: Args, project: string, q: string) {
      const view = hit.view as View | undefined;
      const capture = hit.capture as { id: number; at: string; event: string; excerpt: string } | undefined;
      const id = view ? (hit.source === "repo" ? `repo:${view.id}` : view.id) : `capture:${capture?.id}`;
      return { id, kind: view ? `${String(hit.source)} ${view.kind}` : `capture ${capture?.event ?? ""}`, title: oneLine(view ? view.title ?? view.text : capture?.excerpt ?? "", 100),
        ...(view?.title ? { detail: oneLine(view.text, 120) } : {}), ...(view?.at ?? capture?.at ? { at: view?.at ?? capture?.at } : {}), link: { panel: "find", params: { project, q } } };
    }

    async function panel(name: string, args: Args, project: string): Promise<Args> {
      switch (name) {
        case "review": return { ...(await pending(project, true)), selected: str(args.id) ?? null };
        case "find": {
          const q = str(args.q);
          if (!q) return { q: "", hits: [] };
          return { q, ...(await read(project, "amem_search", { ...args, query: q }) as Args) };
        }
        case "timeline": return { entries: await read(project, "amem_timeline", args) };
        case "work": return { lists: await read(project, "amem_work_state_read", args) };
        case "goals": {
          const store = openCuratedForRead(base, project), p = policy();
          try {
            return { goals: (store?.goals(project) ?? []).filter(goal => p.screenStandalone(goal))
              .map(g => ({ id: g.id, at: g.at, title: g.title, state: g.state, milestones: g.milestones, dependsOn: g.dependsOn, links: g.links.map(l => l.task) })) };
          } finally { store?.close(); }
        }
        default: return {};
      }
    }

    // Undo stays bound to what this console just did: an accepted or edited note to forget, a rejection to withdraw.
    const undo = new Map<string, { kind: "accept" | "reject"; project: string; noteId?: string; reopen?: boolean; until: number }>();
    function candidateFor(args: Args): Found | string {
      const id = str(args.id);
      if (!id || !/^[a-f0-9]{64}$/.test(id)) return "a full 64-character candidate id is required";
      if (!hasCandidates()) return "candidate unavailable";
      const asked = str(args.project);
      const project = asked ? resolveAlias(base, asked) : projectOf.get(id) ?? projects().find(p => withCandidates(p, c => c.get(id, p)));
      const candidate = project ? withCandidates(project, c => c.get(id, project)) : undefined;
      return project && candidate ? { id, project, candidate } : "candidate unavailable";
    }
    /** The console never acts on a candidate it would not show. */
    function hiddenReason(found: Found): string | undefined {
      if (found.candidate.status !== "pending") return `candidate is ${found.candidate.status}, not pending`;
      const store = openCuratedForRead(base, found.project);
      try { return visible(found.candidate, found.project, store, policy()) ? undefined : "this candidate is withheld by the privacy screen; review it with amem review walk"; }
      finally { store?.close(); }
    }

    async function accept({ id, project, candidate }: Found): Promise<ActionResult> {
      const p = policy();
      if (candidate.input.kind === "decay") return { ok: false, error: "decay candidates are listing-only; use amem demote or amem forget after review" };
      // `amem review accept`: the current policy screens the proposal, then acceptance screens the note it writes with its target and goal.
      if (!await p.screen(candidate.input)) return refusal(candidate.input, p);
      let declined: unknown;
      const store = openCurated(base, project, { deferPromotions: true, screen: note => policy().screenStandalone(note) ? "promote" : "keep" });
      try {
        const result = withCandidates(project, c => c.accept(id, { project, actor: ACTOR, verdict: "public", store, policyVersion,
          policy: (proposal, target, note, goal) => {
            const value = { ...proposal.input, ...(target ? { targetView: target } : {}), note, ...(goal ? { goalView: goal } : {}) };
            if (policy().screenStandalone(value)) return true;
            declined = value; return false;
          } }));
        // A promotion hides its short-term source; forgetting the copy would not bring that back, so it gets no undo.
        const reversible = candidate.input.kind !== "promotion" && !result.alreadyAccepted;
        if (reversible) undo.set(id, { kind: "accept", project, noteId: result.noteId, until: Date.now() + UNDO_MS });
        return { ok: true, message: `Accepted as note ${result.noteId.slice(0, 8)}`, noteId: result.noteId, ...(reversible ? { undo: { action: "accept_undo", id, project } } : {}) };
      } catch (e) {
        if (declined !== undefined) return refusal(declined, p);
        return { ok: false, error: errorText(e) };
      } finally { store.close(); }
    }
    function editAccept({ id, project, candidate }: Found, text: string | undefined): ActionResult {
      const input = candidate.input;
      if (input.kind !== "memory" && input.kind !== "fail") return { ok: false, error: "edit is for memory and fail candidates; accept or reject this one" };
      if (!text) return { ok: false, error: "the edited text is required" };
      const p = policy(), asFail = input.kind === "fail" || input.noteKind === "fail";
      const title = input.kind === "memory" && input.title ? { title: input.title } : {};
      const store = openCurated(base, project, { deferPromotions: true, screen: note => p.screenStandalone(note) ? "promote" : "keep" });
      let noteId: string;
      try {
        // `review walk`'s edit: the person's own long-term note, then the candidate is closed.
        noteId = noteAdd(store, project, asFail ? { kind: "fail", tier: "long", scope: "project", fail: parseFailTemplate(text), ...title }
          : { kind: input.kind === "memory" ? input.noteKind ?? "finding" : "finding", tier: "long", scope: "project", text, ...title }, p).id;
      } catch (e) {
        return /privacy policy/.test(errorText(e)) ? refusal({ text, ...title }, p) : { ok: false, error: errorText(e) };
      } finally { store.close(); }
      withCandidates(project, c => c.reject(id, { project, actor: ACTOR, verdict: "public" }));
      undo.set(id, { kind: "accept", project, noteId, reopen: true, until: Date.now() + UNDO_MS });
      return { ok: true, message: `Saved your edit as note ${noteId.slice(0, 8)}; the candidate is closed`, noteId, undo: { action: "accept_undo", id, project } };
    }
    function undoFor(args: Args, kind: "accept" | "reject") {
      const id = str(args.id) ?? "", entry = undo.get(id);
      if (!entry || entry.kind !== kind) return undefined;
      undo.delete(id);
      return entry.until >= Date.now() ? { id, ...entry } : undefined;
    }

    /** Destructive forms: the first call previews; a write needs the console's confirmation with the same fingerprint, recomputed here. */
    const gate = (input: Args, fingerprint: string, view: Preview): ActionResult | undefined =>
      input.confirmed === true && input.fingerprint === fingerprint ? undefined : { ok: false, needsConfirm: true, fingerprint, ...view };
    function projectArg(args: Args): string {
      const asked = str(args.project);
      if (!asked) throw new Error("project is required");
      const key = resolveAlias(base, asked);
      assertProjectActive(base, key);
      return key;
    }
    async function destructive(input: Args): Promise<ActionResult> {
      if (!existsSync(base)) return { ok: false, error: "no memory home yet" };
      switch (input.action) {
        case "gc": {
          const plan = runGc(base, { dryRun: true });
          const blocked = gate(input, sha(plan), { verb: "Evict capture rows", preview: gcText(plan).split("\n"),
            changes: plan.shards.filter(s => s.expired > 0).map(s => ({ op: "delete", target: `capture rows of ${s.key}`, note: `${s.expired} expired` })) });
          return blocked ?? { ok: true, message: gcText(runGc(base)).split("\n").slice(0, 3).join("; ") };
        }
        case "capacity_apply": {
          const report = capacityReport({ memoryDir: base });
          if (!await policy().screen(report)) return refusal(report, policy());
          const file = join(base, "capture-config.json"), current = readCaptureConfigFile(file);
          const target = { capMb: report.proposal.capMb, retentionDays: report.proposal.retentionDays };
          // `amem capacity apply`: the CLI's preview file is replaced by the console's confirm token, bound to the same values.
          const blocked = gate(input, sha({ file, current, target }), { verb: "Apply capacity", changes: [{ op: existsSync(file) ? "modify" : "create", target: file }],
            preview: [`cap_mb: ${current.capMb ?? "default"} -> ${target.capMb}`, `retention_days: ${current.retentionDays ?? "default"} -> ${target.retentionDays}`, `reason: ${report.proposal.reason}`] });
          if (blocked) return blocked;
          const written = writeCaptureConfigFile(file, target);
          return { ok: true, message: `Capture capacity set to ${written.capMb} MB, ${written.retentionDays} days` };
        }
        case "project_forget": {
          const key = requireShard(base, projectArg(input)), state = projectState(base, key), shard = readCatalogFresh(base).find(p => p.key === key);
          const blocked = gate(input, sha({ key, state }), { verb: "Forget project", changes: [{ op: "log", target: "lifecycle.jsonl", note: `forget ${key}` }],
            preview: [`forget ${key} (now ${state}; capture ${shard?.captureRows ?? 0} rows)`, "Forget is an append-only record that takes the project out of recall and every listing for good. Nothing is erased."],
            warnings: ["This cannot be undone."] });
          if (blocked) return blocked;
          appendLifecycle(base, { op: "forget", key, actor: ACTOR, machine: machineId(base).id });
          return { ok: true, message: `Forgot ${key}` };
        }
        case "decay_apply": {
          const project = projectArg(input), forget = input.forget === true || input.forget === "true";
          const days = input.days === undefined ? DECAY_DEFAULT_DAYS : Number(input.days);
          if (!Number.isSafeInteger(days) || days < 1) return { ok: false, error: "days must be a positive whole number" };
          const aliases = aliasedKeys(base, project);
          const store = openCurated(base, project, { deferPromotions: true, screen: note => policy().screenStandalone(note) ? "promote" : "keep" });
          try {
            const current = { days, aliases, counters: () => readDecayCounters(base, [project, ...aliases]), screen: (view: View) => policy().screenStandalone(view) };
            const plan = decayPreview(store, project, current), action = forget ? "forget" : "demote";
            const blocked = gate(input, sha({ project, action, days, targets: plan.entries.map(e => e.target) }), {
              verb: forget ? "Forget old notes" : "Demote old notes",
              preview: [`${action}: ${plan.entries.length} notes older than ${days} days in ${project}${plan.truncated ? " (truncated)" : ""}; citation history unknown`,
                ...plan.entries.map(e => `mem:${e.target.id}  ${e.view.at.slice(0, 10)}  ${e.view.kind}: ${oneLine(e.view.title ?? e.view.text, 80)}`)],
              changes: plan.entries.map(e => ({ op: forget ? "delete" : "modify", target: `mem:${e.target.id}`, note: forget ? "forget" : `short-term, expires ${plan.demoteExpiresAt}` })),
              ...(plan.withheld ? { warnings: [`${plan.withheld} notes withheld by the privacy screen are left alone`] } : {}) });
            if (blocked) return blocked;
            if (!plan.entries.length) return { ok: true, message: "No eligible notes" };
            if (forget) assertExactDecayForget(store, plan.entries.map(e => e.target.id), project);
            const result = applyDecay(store, plan, { ...current, actor: ACTOR, confirmed: true, forget });
            return { ok: true, message: `${result.action}: ${result.ids.length} notes` };
          } finally { store.close(); }
        }
        case "prune": {
          const project = projectArg(input), cutoff = str(input.cutoff);
          if (!cutoff) return { ok: false, error: "cutoff is required (UTC time)" };
          const store = openCurated(base, project, { deferPromotions: true }, false);
          try {
            const auth = { project, actor: ACTOR, authorize: () => true }, port = store.prunePort();
            const plan = planPrune(port, { cutoff }, auth);
            const blocked = gate(input, plan.seal, { verb: "Prune expired notes", preview: pruneText(plan).split("\n"),
              changes: plan.rows.map(r => ({ op: "log", target: `${r.placement} prune row`, note: `${r.payload.targets.length} targets` })) });
            return blocked ?? { ok: true, message: `Pruned: ${applyPrune(port, JSON.stringify(plan), auth).completed.length} rows` };
          } finally { store.close(); }
        }
      }
      return { ok: false, error: `unknown action ${String(input.action)}` };
    }

    return {
      assets: { js: asset("./panel.js"), css: asset("./panel.css") },
      async snapshot(input) {
        const args = input as Args;
        if (input.panel === "inbox") return { items: await inbox() };
        const list = projects(), project = pick(args, list);
        if (input.panel === "search") {
          const q = str(args.q);
          if (!q || !project) return { hits: [], total: 0 };
          const limit = Math.min(10, Math.max(1, Number(args.limit) || 10));
          const result = await read(project, "amem_search", { query: q, limit }) as { hits: Args[] };
          const hits = result.hits.map(hit => searchHit(hit, project, q));
          return { hits, total: hits.length };
        }
        if (input.panel === "capacity") return { projects: list, project: project ?? null, ...(await capacity() ?? { report: null }) };
        if (!project) return { projects: list, project: null };
        try { return { projects: list, project, ...(await panel(input.panel, args, project)) }; }
        catch (e) {
          ctx.log(`amem: ${input.panel} for ${project} failed: ${errorText(e)}`);
          return { projects: list, project, error: "Memory is unavailable for this project right now; details are in the terminal." };
        }
      },
      async action(input) {
        const args = input as Args;
        try {
          switch (input.action) {
            case "accept": case "reject": case "edit_accept": {
              const found = candidateFor(args);
              if (typeof found === "string") return { ok: false, error: found };
              const hidden = hiddenReason(found);
              if (hidden) return { ok: false, error: hidden };
              if (input.action === "accept") return await accept(found);
              if (input.action === "edit_accept") return editAccept(found, str(args.text));
              withCandidates(found.project, c => c.reject(found.id, { project: found.project, actor: ACTOR, verdict: "public" }));
              undo.set(found.id, { kind: "reject", project: found.project, until: Date.now() + UNDO_MS });
              // agent-mem stores no reject reason (no new storage, #158 non-goals); the reply says so instead of dropping it silently.
              return { ok: true, message: str(args.reason) ? "Rejected; agent-mem keeps no reject reason, so it was not recorded" : "Rejected", undo: { action: "reject_undo", id: found.id, project: found.project } };
            }
            case "reject_undo": {
              const entry = undoFor(args, "reject");
              if (!entry) return { ok: false, error: "nothing to undo for this candidate" };
              withCandidates(entry.project, c => c.reopen(entry.id, { project: entry.project, actor: ACTOR }));
              return { ok: true, message: "Reject undone; the candidate is pending again" };
            }
            case "accept_undo": {
              const entry = undoFor(args, "accept");
              if (!entry?.noteId) return { ok: false, error: "nothing to undo for this candidate" };
              // Append-only: a forget op hides the note, and a note it replaced shows again. Nothing is deleted.
              const store = openCurated(base, entry.project, { deferPromotions: true });
              try { if (!store.forget(entry.noteId, ACTOR, entry.project, true)) return { ok: false, error: "the accepted note is no longer available" }; }
              finally { store.close(); }
              if (entry.reopen) withCandidates(entry.project, c => c.reopen(entry.id, { project: entry.project, actor: ACTOR }));
              return { ok: true, message: entry.reopen ? "Undone; the note is forgotten and the candidate is pending again" : "Undone; the accepted note is forgotten" };
            }
            case "gc": case "capacity_apply": case "project_forget": case "decay_apply": case "prune": return await destructive(args);
            default: return { ok: false, error: `unknown action ${input.action}` };
          }
        } catch (e) {
          ctx.log(`amem: ${input.action} failed: ${errorText(e)}`);
          return { ok: false, error: errorText(e) };
        }
      },
    };
  },
};

export default plugin;
