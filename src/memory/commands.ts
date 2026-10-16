import { extractNodes, GOAL_STATES, KINDS, MemoryStore, setMachineLabel, type GoalState, type GoalView, type Kind, type Tier, type View } from "./store.ts";
import { syncMemory, type SyncOptions } from "./sync.ts";
import { importClaudeMem } from "./import.ts";
import { memoryProjectKey, projectChain } from "./project.ts";

export interface MemoryCommandOptions {
  store?: MemoryStore;
  sync?: Omit<SyncOptions, "remote">;
  open: () => MemoryStore;
  readable: (notes: View[]) => View[];
  importPolicy: () => (text: string) => boolean;
}
export interface GoalCommandOptions {
  store?: MemoryStore;
  link?: (goal: string, task: string) => Promise<string>;
  open: () => MemoryStore;
  clean: (title: string, milestones: string[], project: string) => boolean;
}

/**
 * #258: `ahub memory`, straight on the machine's store (no hub needed). Reading is anyone's; promote, demote, forget,
 * supersede and rebuild are a person's (the identity gate refuses agent shells).
 */
export const MEMORY_USAGE = "usage: ahub memory [list] [--tier short|long] [--kind <kind>] [--peer <p>] [--machine <id>] [--since <iso>] [--limit N] | search <words> | show <id> | graph <id|node> [--hops 1|2] | promote|demote|forget <id> | supersede <old> <new> | rebuild | sync [--remote <url>] | machine [--label <name>] | import claude-mem [--db <path>] [--limit N] [--restart] | dedupe [--apply] | suggestions | confirm|reject <suggestion id>  [--json]";
export const GOAL_USAGE = "usage: ahub goal [list] [--all] | show <id> | new <title> [--milestone <text>]... [--depends <id>]... [--shared] | link <id> <task id> | state <id> open|active|blocked|done|dropped | done <id> | take <id> [--force]  [--json]";

const fail = (message: string): never => { throw new Error(message); };
const one = (v: View) => `${v.id.slice(0, 8)}  ${v.at.slice(0, 16).replace("T", " ")}  ${v.tier.padEnd(5)} ${v.kind.padEnd(8)} ${v.peer.padEnd(8)} ${v.scope === "shared" ? "shared " : ""}${`${v.title ? `${v.title}: ` : ""}${v.text}`.replace(/\s+/g, " ").slice(0, 100)}${v.supersededBy ? `  (superseded by ${v.supersededBy.slice(0, 8)})` : ""}`;
function detail(v: View): string[] {
  return [`${v.id}  ${v.kind}, ${v.tier}-term${v.expiresAt ? ` until ${v.expiresAt}` : ""}, ${v.scope}`, `by ${v.peer} on machine ${v.machine}, ${v.at}, project ${v.project}${v.task ? `, task ${v.task}` : ""}`,
    ...(v.promotedFrom ? [`promoted from ${v.promotedFrom}`] : []), ...(v.supersededBy ? [`superseded by ${v.supersededBy}`] : []), ...(v.about.length ? [`about: ${v.about.join(", ")}`] : []), "", ...(v.title ? [v.title] : []), v.text];
}

export async function rawMemoryCommand(args: string[], cwd: string, opts: MemoryCommandOptions): Promise<string> {
  const json = args.includes("--json");
  const rest = args.filter((a) => a !== "--json");
  const flag = (name: string) => { const i = rest.indexOf(name); if (i < 0) return undefined; const v = rest[i + 1] ?? fail(`${name} needs a value`); rest.splice(i, 2); return v; };
  const sub = rest[0] && !rest[0].startsWith("--") ? rest.shift()! : "list";
  const store = opts.store ?? opts.open();
  const actor = "user";
  const project = memoryProjectKey(cwd);
  const need = (v: View | undefined, id: string) => v ?? fail(`no memory entry ${id} (ahub memory list shows the ids)`);
  try {
    switch (sub) {
      case "list": case "search": {
        const tier = flag("--tier"), kind = flag("--kind"), peer = flag("--peer"), machine = flag("--machine"), since = flag("--since"), limit = flag("--limit");
        if (since !== undefined && Number.isNaN(Date.parse(since))) fail(`--since needs a date or time (ISO 8601), not ${since}`);
        if (tier && tier !== "short" && tier !== "long") fail("--tier takes short or long");
        if (kind && !KINDS.includes(kind as Kind)) fail(`--kind takes ${KINDS.join(", ")}`);
        if (limit && !(Number(limit) > 0)) fail("--limit takes a positive number");
        const q = sub === "search" ? rest.join(" ") || fail("usage: ahub memory search <words>") : rest.length ? fail(MEMORY_USAGE) : undefined;
        // Agent shells may run this: notes are screened under this project's current PII policy, as briefs and recall are
        // (a shared note was accepted under another project's patterns). The dashboard shows a person everything.
        const all = store.list({ project, ...(tier ? { tier: tier as Tier } : {}), ...(kind ? { kind: kind as Kind } : {}), ...(peer ? { peer } : {}), ...(machine ? { machine } : {}), ...(since ? { since } : {}), ...(q ? { q } : {}), limit: Number.MAX_SAFE_INTEGER });
        // Screened first, then cut to the limit: withheld entries never crowd out readable ones.
        const readable = opts.readable(all), rows = readable.slice(0, limit ? Number(limit) : 50);
        if (json) return JSON.stringify(rows, null, 2);
        const c = store.counts(project);
        const withheld = all.length - readable.length;
        return [`hub memory for ${project} on machine ${c.machine.label}: ${c.long} long-term, ${c.short} short-term`, ...(rows.length ? rows.map(one) : ["(nothing)"]),
          ...(withheld ? [`(${withheld} withheld: they match a PII pattern; the dashboard shows them)`] : [])].join("\n");
      }
      case "show": {
        const id = rest[0] ?? fail("usage: ahub memory show <id>");
        const v = need(store.get(id, project), id);
        if (!opts.readable([v]).length) fail(`${v.id.slice(0, 8)} is withheld: it matches a PII pattern (the dashboard shows it)`);
        return json ? JSON.stringify(v, null, 2) : detail(v).join("\n");
      }
      case "graph": {
        const hops = Number(flag("--hops") ?? 1);
        if (hops !== 1 && hops !== 2) fail("--hops takes 1 or 2");
        const start = rest[0] ?? fail("usage: ahub memory graph <id|node>");
        const node = start.includes(":") && !start.startsWith("mem:") ? start : `mem:${need(store.get(start, project), start).id}`;
        const g = store.graph(project, node, hops);
        return json ? JSON.stringify(g, null, 2) : [`${g.nodes.length} nodes, ${g.edges.length} edges around ${node}`, ...g.edges.map((e) => `${e.from} -${e.rel}-> ${e.to}`)].join("\n");
      }
      case "promote": { const v = need(store.get(rest[0] ?? fail(MEMORY_USAGE), project), rest[0]!); if (v.supersededBy) fail(`${v.id.slice(0, 8)} is replaced by ${v.supersededBy.slice(0, 8)}: promote that one instead`); const id = store.promote(v.id, actor, project) ?? fail(v.project !== project ? `${v.id.slice(0, 8)} is another project's note: promote it from that project` : `${v.id.slice(0, 8)} stays short-term: it holds a secret, matches a PII pattern or is about a private path`); return id === v.id ? `${v.id.slice(0, 8)} is already long-term` : `promoted to long-term as ${id.slice(0, 8)}`; }
      case "demote": { const v = need(store.get(rest[0] ?? fail(MEMORY_USAGE), project), rest[0]!); if (v.tier !== "long") return `${v.id.slice(0, 8)} is already short-term`; store.demote(v.id, actor, project); return `demoted ${v.id.slice(0, 8)}: it expires ${store.get(v.id, project)?.expiresAt ?? "with its short-term lifetime"}`; }
      case "forget": { const v = need(store.forget(rest[0] ?? fail(MEMORY_USAGE), actor, project), rest[0]!); return `forgot ${v.id.slice(0, 8)}${v.local ? "" : "; it stays in the sync remote's git history until a person rewrites it (docs/memory.md)"}`; }
      case "supersede": {
        if (rest.length !== 2) fail("usage: ahub memory supersede <old> <new>");
        return store.supersede(rest[0]!, rest[1]!, actor, project) ? `${rest[0]} is superseded by ${rest[1]}` : fail("both ids must name different entries, and the newer one must reach as far: shared for a shared entry, long-term for a long-term one (ahub memory promote it first)");
      }
      case "sync": {
        const remote = flag("--remote");
        if (rest.length) fail("usage: ahub memory sync [--remote <private git url>]");
        const r = await syncMemory(store, { ...opts.sync, ...(remote ? { remote } : {}) });
        if (json) return JSON.stringify(r, null, 2);
        if (!r.ok) fail(`hub memory sync: ${r.error}`);
        return `synced${r.pushed ? " and pushed" : ""}: ${r.entries} long-term entries visible here${r.warning ? `\nnote: ${r.warning}` : ""}`;
      }
      case "dedupe": {
        const apply = rest.includes("--apply");
        if (rest.some(arg => arg !== "--apply")) fail("usage: ahub memory dedupe [--apply] [--json]");
        const result = store.dedupe(project, apply);
        if (json) return JSON.stringify(result, null, 2);
        return [result.groups.length ? `${result.groups.length} duplicate import group(s)${apply ? `; appended ${result.applied} supersede operation(s)` : "; use --apply to reconcile"}` : "no duplicate import groups to reconcile",
          ...result.groups.map(g => `${g.members.map(v => v.id.slice(0, 8)).join(", ")} -> ${g.target.slice(0, 8)}: ${g.members[0]!.text}`)].join("\n");
      }
      case "import": {
        const db = flag("--db"), limit = flag("--limit");
        const restart = rest.includes("--restart");
        if (restart) rest.splice(rest.indexOf("--restart"), 1);
        if (rest[0] !== "claude-mem" || rest.length !== 1) fail("usage: ahub memory import claude-mem [--db <path>] [--limit N] [--restart]");
        if (limit && !(Number(limit) > 0)) fail("--limit takes a positive number");
        const isPii = opts.importPolicy();
        const key = memoryProjectKey(cwd);
        const nodes = (text: string) => extractNodes(text, { cwd, project: key, repo: key.startsWith("github.com/") ? key.slice("github.com/".length) : key, checkExists: false });
        const r = importClaudeMem(store, { project: key, chain: projectChain(cwd), nodes, restart, isPii, ...(db ? { db } : {}), ...(limit ? { limit: Number(limit) } : {}) });
        if (json) return JSON.stringify(r, null, 2);
        return `imported ${r.added} of ${r.read} hub notes from claude-mem as long-term entries (skipped: ${r.skipped.model} model answers, ${r.skipped.pii} PII, ${r.skipped.secret} secret-looking; other candidates were empty, malformed or already imported)${r.more ? "\nmore remain: run it again" : ""}`;
      }
      case "suggestions": {
        const pending = store.suggestions(project).filter((x) => x.status === "suggested");
        if (json) return JSON.stringify(pending, null, 2);
        return pending.length ? pending.map((x) => `${x.id.slice(0, 8)}  ${x.from.slice(0, 8)} ${x.rel} ${x.to.slice(0, 8)}  (suggested by the hub's model ${x.at}; not evidence until confirmed)`).join("\n") : "no edge suggestions waiting";
      }
      case "confirm": case "reject": {
        const x = store.judge(rest[0] ?? fail(`usage: ahub memory ${sub} <suggestion id>`), sub, actor, project) ?? fail(`no suggestion ${rest[0]} (ahub memory suggestions lists them)`);
        return `${sub === "confirm" ? "confirmed" : "rejected"}: ${x.from.slice(0, 8)} ${x.rel} ${x.to.slice(0, 8)}`;
      }
      case "machine": {
        const label = flag("--label");
        const m = label ? setMachineLabel(store.dir, label) : store.machine;
        return json ? JSON.stringify(m) : `this machine: ${m.id} (${m.label})`;
      }
      case "rebuild": { store.rebuild(); const c = store.counts(); return `rebuilt the index from ${c.segments} segment${c.segments === 1 ? "" : "s"}: ${c.long} long-term, ${c.short} short-term entries`; }
      default: return fail(MEMORY_USAGE);
    }
  } finally { if (!opts.store) store.close(); }
}

const goalOne = (g: GoalView, me: string) => `${g.id.slice(0, 8)}  ${g.state.padEnd(7)} ${g.title}${g.scope === "shared" ? "  [shared]" : ""}  ${leaseText(g, me)}`;
function leaseText(g: GoalView, me: string): string {
  const who = (m: string) => m === me ? "this machine" : `machine ${m.slice(0, 8)}`;
  if (g.lease.holder) return `held by ${who(g.lease.holder)} until ${g.lease.until}${g.lease.conflict.length ? `, CONFLICT with ${g.lease.conflict.map(who).join(", ")} (the earlier claim holds; a person settles it with ahub goal take --force)` : ""}`;
  return g.lease.expired ? `free (${who(g.lease.lastHolder!)}'s lease ended ${g.lease.until})` : "free";
}

/**
 * #258: `ahub goal`, long-term tasks. Listing and showing are anyone's; new, link, state, done and take are a
 * person's. A peer links its own board task with hub_task_propose's `goal`.
 */
export async function rawGoalCommand(args: string[], cwd: string, opts: GoalCommandOptions): Promise<string> {
  const json = args.includes("--json");
  const rest = args.filter((a) => a !== "--json");
  const take = (name: string) => { const out: string[] = []; for (let i = rest.indexOf(name); i >= 0; i = rest.indexOf(name)) { out.push(rest[i + 1] ?? fail(`${name} needs a value`)); rest.splice(i, 2); } return out; };
  const sub = rest[0] && !rest[0].startsWith("--") ? rest.shift()! : "list";
  const store = opts.store ?? opts.open();
  const project = memoryProjectKey(cwd);
  const me = store.machine.id;
  // Only this project's long-term tasks and shared ones, like every other lookup an agent may run.
  const need = (id: string | undefined) => store.goalOf(id?.replace(/^goal:/, "") ?? fail(GOAL_USAGE), project) ?? fail(`no long-term task ${id} for this project (ahub goal list shows them)`);
  const clean = (title: string, milestones: string[], of = project) => opts.clean(title, milestones, of);
  try {
    switch (sub) {
      case "list": {
        const all = rest.includes("--all");
        const listed = store.goals(project).filter((g) => all || (g.state !== "done" && g.state !== "dropped"));
        const goals = listed.filter((g) => clean(g.title, g.milestones, g.project)), withheld = listed.length - goals.length;
        if (json) return JSON.stringify(goals, null, 2);
        return [...(goals.length ? goals.map((g) => goalOne(g, me)) : [`no ${all ? "" : "open "}long-term tasks for ${project} (ahub goal new <title>)`]),
          ...(withheld ? [`(${withheld} withheld: they match a PII pattern or a private path)`] : [])].join("\n");
      }
      case "show": {
        const g = need(rest[0]);
        if (!clean(g.title, g.milestones, g.project)) fail(`${g.id.slice(0, 8)} is withheld: it matches a PII pattern or a private path`);
        if (json) return JSON.stringify(g, null, 2);
        return [goalOne(g, me), `${g.id}, project ${g.project}, created ${g.at} on machine ${g.machine.slice(0, 8)}`,
          ...g.milestones.map((m) => `milestone: ${m}`), ...g.dependsOn.map((d) => `depends on ${d.slice(0, 8)}`),
          ...(g.links.length ? g.links.map((l) => `board task ${l.task} (linked ${l.at} on machine ${l.machine.slice(0, 8)})`) : ["no board tasks linked yet"])].join("\n");
      }
      case "new": {
        const milestones = take("--milestone"), depends = take("--depends").map((d) => need(d).id);
        const shared = rest.includes("--shared");
        const title = rest.filter((a) => a !== "--shared").join(" ").trim() || fail(GOAL_USAGE);
        if (!clean(title, milestones)) fail("a long-term task syncs to every machine: this one holds a secret, a PII pattern or a private path and is not saved");
        const id = store.goal({ project, scope: shared ? "shared" : "project", title, milestones, dependsOn: depends, actor: "user" });
        return `long-term task ${id.slice(0, 8)} created: ${title}`;
      }
      case "link": {
        const g = need(rest[0]);
        const task = rest[1] ?? fail("usage: ahub goal link <id> <task id>");
        if (!/^\d+$/.test(task)) fail("the task is a board task id of this project");
        return await (opts.link ?? fail("linking needs this project's hub running (ahub up)"))(g.id, task);
      }
      case "state": case "done": {
        const g = need(rest[0]);
        const state = (sub === "done" ? "done" : rest[1]) as GoalState;
        if (!GOAL_STATES.includes(state)) fail(`the state is one of ${GOAL_STATES.join(", ")}`);
        store.goalState(g.id, state, "user");
        return `long-term task ${g.id.slice(0, 8)} is ${state}`;
      }
      case "take": {
        const g = need(rest[0]);
        const r = store.take(g.id, "user", { force: rest.includes("--force") });
        if (!r.ok) fail(`held by machine ${r.holder.slice(0, 8)} until ${r.until}; wait for it to expire or take it over with --force`);
        return `this machine holds long-term task ${g.id.slice(0, 8)} until ${r.until}${rest.includes("--force") ? " (earlier claims are void)" : ""}`;
      }
      default: return fail(GOAL_USAGE);
    }
  } finally { if (!opts.store) store.close(); }
}
