import { HOOK_EVENTS } from "./hook-contract.ts";
import { GOAL_STATES, KINDS } from "./memory/store.ts";
import { cellWidth, wrap } from "@staix/cli-output";
import { wrapReport } from "./memory/style.ts";

/** `number` and `date` are help labels for a text value (#590 H3); the parser and completion treat them as text. */
export interface OptionDefinition { description: string; details?: string; value?: "text" | "path" | "number" | "date" | readonly string[] }
export interface ArgumentDefinition { name: string; values?: readonly string[]; path?: boolean; variadic?: boolean; optional?: boolean }
export type CommandGroup = "read" | "write" | "review" | "maintenance" | "setup";
export interface CommandDefinition {
  /** #590 H1: one imperative verb phrase, at most 60 ASCII characters, no design references. */
  description: string;
  /** Longer description, shown under `▸ Details` in this command's help. */
  details?: string;
  /** #590 H6: complete command lines, each resolved against `COMMANDS` by the help lint. */
  examples?: readonly string[];
  /** Root overview group of a top-level command (#590 H2). */
  group?: CommandGroup;
  options?: Record<string, OptionDefinition>;
  args?: readonly ArgumentDefinition[];
  commands?: Record<string, CommandDefinition>;
  /** `confirm`: previews without `--confirm` (a read), and mutates with it (#15 T5: gc, project forget, capacity apply). */
  mutates?: boolean | "apply" | "label" | "confirm";
  policyFree?: boolean;
  defaultCommand?: string;
}
const flag = (description: string, details?: string): OptionDefinition => ({ description, ...(details ? { details } : {}) });
const text = (description: string, details?: string): OptionDefinition => ({ description, value: "text", ...(details ? { details } : {}) });
const number = (description: string, details?: string): OptionDefinition => ({ description, value: "number", ...(details ? { details } : {}) });
const date = (description: string, details?: string): OptionDefinition => ({ description, value: "date", ...(details ? { details } : {}) });
const path = (description: string, details?: string): OptionDefinition => ({ description, value: "path", ...(details ? { details } : {}) });
const json = (what: string) => ({ "--json": flag(`Print ${what} as JSON`) });
const history = { "--history": flag("Read retained supersession and expiry history", "Forgotten text stays hidden."),
  "--as-of": date("Read memory as of a past UTC date or timestamp", "Current forget and prune masks still apply.") };
const policy = { "--policy-free": flag("Accepted and ignored", "The configured privacy policy always applies.") };
// Declared on import codex and claude-auto so their handler keeps its own refusal text for these claude-mem flags.
const claudeMemOnly = Object.fromEntries(["--db", "--limit", "--restart", "--capture-days"].map(name => [name, { description: "Only for import claude-mem; refused here", ...(name === "--restart" ? {} : { value: "text" as const }) }])) as Record<string, OptionDefinition>;
const CANDIDATE_KINDS = ["correction", "fail", "decay", "memory", "promotion", "consolidation", "model-answer"] as const;
const filters = (what: string) => ({ ...json(what), "--tier": { description: "Memory tier", value: ["short", "long"] } as OptionDefinition,
  "--kind": { description: "Note kind", value: KINDS } as OptionDefinition, "--peer": text("Author peer"), "--machine": text("Machine ID"),
  "--since": date("Only notes since this ISO date or time"), "--limit": number("Maximum results") });
export const GLOBAL_OPTIONS = { "--help": flag("Show help"), "--color": { description: "Color output: auto, always or never", value: ["auto", "always", "never"] } as OptionDefinition, "--ascii": flag("Use ASCII markers") };
export const ROOT_OPTIONS = { "--version": flag("Show version"), ...json("the notes") };
const setupTargets = ["claude", "codex", "kimi", "pi", "qwen", "jcode", "opencode", "gemini", "agy", "all", "console"] as const;
export const COMMANDS: Record<string, CommandDefinition> = {
  consolidate: { group: "review", description: "Queue consolidation candidates for review", details: "Deterministic and project-local. Curated notes change only after explicit acceptance.",
    examples: ["amem consolidate", "amem consolidate --json"], mutates: true,
    options: { ...json("the queued candidates"), "--project": text("This project's key", "Another project is refused; run from its directory.") } },
  setup: { group: "setup", description: "Preview or apply MCP setup and capture hooks",
    details: "Covers native coding CLIs, or the acon console plugin manifest (console). Apply and undo use explicit flags.",
    examples: ["amem setup claude", "amem setup all --apply", "amem setup agy --list"],
    options: { ...json("the setup plan or receipt list"), "--list": flag("List Antigravity receipt workspaces and repair commands (agy only)"), "--apply": flag("Apply the previewed setup"), "--undo": flag("Restore the original configuration"),
      "--verbose": flag("Show static notes and history lines (human output only)"),
      "--root": path("Register this absolute install root", "Such as <install>/releases/<version>/, resolved to its real path, instead of the running one."),
      "--adopt-current": flag("With --apply: adopt the current wiring", "Keeps a stale setup receipt aside (its entries were replaced at another install root) and adopts the current wiring, which --undo restores.") },
    args: [{ name: "target", values: setupTargets }] },
  skills: { group: "setup", description: "Export packaged skills to a directory", commands: {
    export: { description: "Export self-contained skills", examples: ["amem skills export ./skills"], options: json("the export receipt"), args: [{ name: "dir", path: true }], mutates: true } } },
  mcp: { group: "setup", description: "Run the project-bound MCP stdio server" },
  manifest: { group: "setup", description: "Describe this install, its MCP tools and commands", details: "Package name, version, MCP server and tools (read-only ones marked), and the command list.",
    examples: ["amem manifest --json"], options: json("the manifest") },
  hook: { group: "setup", description: "Run a fail-open, context-only capture hook", examples: ["amem hook SessionStart"], args: [{ name: "event", values: [...HOOK_EVENTS, "jcode"] }] },
  ingest: { group: "setup", description: "Capture native session transcripts incrementally", details: "Runs once per call; no watcher.",
    examples: ["amem ingest codex", "amem ingest pi --since 2026-11-01"], options: { ...json("the ingest receipt"), "--since": date("Only transcripts since this ISO date or time") },
    args: [{ name: "kind", values: ["codex", "kimi", "pi", "qwen"] }] },
  "vault-candidates": { group: "read", description: "List screened durable vault candidates", details: "Per project, or across projects with --all-projects.",
    examples: ["amem vault-candidates", "amem vault-candidates --all-projects --limit 20"],
    options: { ...json("the candidates"), "--limit": number("Maximum candidates per project (1..100)"),
      "--all-projects": flag("List every active project's candidates", "The reply says it crossed projects."), "--project": text("List one named project's candidates") } },
  list: { group: "read", description: "List memory notes", examples: ["amem list --kind decision", "amem list --since 2026-11-01 --limit 20"],
    options: { ...filters("the notes"), ...history, "--ungrouped": flag("Accepted for parity with search", "list never folds notes.") } },
  search: { group: "read", description: "Rank this project's curated notes",
    details: "History, as-of and empty queries keep newest-first filtering.",
    examples: ["amem search release gate", "amem search sync --all-projects"],
    options: { ...filters("the ranked notes"), ...history,
      "--filter": flag("Match every word as a substring, newest first", "Current-project curated notes only; not with --all-projects."),
      "--explain": flag("Show the score factors of each result", "Ranked project-local results only."),
      "--ungrouped": flag("List every note of a task, not the best hit"),
      "--all-projects": flag("Search every active project", "The reply says it crossed projects."),
      "--include-archived": flag("With --all-projects, read archived projects") }, args: [{ name: "words", variadic: true }] },
  brief: { group: "read", description: "Read the fails, decisions and contracts for an intent",
    details: "Fails first, then decisions and contracts, as untrusted data within a UTF-8 byte cap.",
    examples: ["amem brief --for sync-lock", "amem brief --for review --paths src/cli.ts"],
    options: { ...json("the brief"), "--for": text("Explicit intent"), "--paths": text("Named path (repeatable)"), "--symbols": text("Named symbol (repeatable)"),
      "--bytes": number("Brief body byte cap (1..8192, default 2048)") } },
  projects: { group: "read", description: "List the project shards of this memory home", examples: ["amem projects", "amem projects --all"],
    options: { ...json("the projects"), "--all": flag("Include forgotten projects", "Archived projects are always listed.") } },
  usage: { group: "read", description: "Show totals and the largest project shards", examples: ["amem usage", "amem usage --limit 5"],
    options: { ...json("the usage totals"), "--limit": number("Largest shards to list (1..100)"), "--all": flag("Include forgotten projects") } },
  eval: { group: "maintenance", description: "Measure search recall@k and MRR on a question set",
    details: "Replays a local question set against ranked search. No model and no network. Without --set it uses the built-in synthetic set; --set ko uses the built-in Korean one.",
    examples: ["amem eval", "amem eval --set ko --k 1,5"],
    options: { ...json("the eval report"),
      "--set": path("Built-in set name (ko) or a question set file", "A file uses amem.eval/v1. With entries it is self-contained; without them its ids name entries of this project."),
      "--k": text("Cutoffs, comma separated (default 1,5,10)", "Each cutoff is 1..100.") }, commands: {
      audit: { description: "Audit whether stored notes are still right", details: "Sample a private sheet, judge it outside amem, then score it. No model and no network.", options: json("the audit result"), commands: {
        sample: { description: "Draw a seeded sample of notes into a private sheet",
          details: "Stratified over this project's curated notes, with anchor status and empty judge columns, in a 0600 sheet.",
          examples: ["amem eval audit sample --seed s1", "amem eval audit sample --seed s1 --n 20"],
          options: { ...json("the sheet receipt"),
            "--project": text("Project key to audit (default: this directory's)"), "--n": number("Notes to draw (1..200, default 40)"),
            "--seed": text("Required seed: 1..64 of letters, digits, . _ -", "The same seed and store draw the same sample."),
            "--as-of": date("Instant the note ages are measured at", "A canonical UTC date or timestamp; default now. Recorded in the sheet so the same seed and as-of draw the same sample."),
            "--out": path("Sheet path (default: this home's eval/ directory)", "Never overwritten, always 0600.") } },
        score: { description: "Score a filled sheet into content-free counts",
          details: "Counts per kind, age and anchor, and Cohen's kappa. Refuses any leak of note text or a path.",
          examples: ["amem eval audit score ./sheet.tsv"], options: json("the score"), args: [{ name: "sheet" }] },
      } } } },
  spool: { group: "maintenance", description: "Maintain the hook spool outside hooks", options: json("the replay plan or receipt"), commands: {
    replay: { description: "Preview or apply a replay of parked hook records",
      details: "The preview is read-only and shows no record bodies. --apply takes the saved preview.",
      examples: ["amem spool replay --json", "amem spool replay --apply --plan plan.json"], mutates: "apply",
      options: { ...json("the replay plan or receipt"),
        "--source": path("Private parked directory to read instead", "An absolute path, read instead of this home's hook spool."),
        "--apply": flag("Apply the saved preview given with --plan"),
        "--confirm-unverifiable": flag("With --apply: replay unproven cwd mappings too", "Also replays the saved plan's 'needs confirmation' cwd -> project mappings, which this boot cannot prove."),
        "--plan": path("Saved preview from amem spool replay --json") } },
  } },
  gc: { group: "maintenance", description: "Apply each shard's retention and cap in batches", details: "Previews without --confirm.",
    examples: ["amem gc", "amem gc --confirm --batches 10"], mutates: "confirm",
    options: { ...json("the gc result"), "--confirm": flag("Evict now; without it, preview only"), "--batches": number("Evict windows per shard (1..1000, default 1)") } },
  project: { group: "maintenance", description: "Export, import, archive or forget one project", options: json("the project receipt"), commands: {
    export: { description: "Write one project's memory to a new export file",
      details: "Curated notes, goals and work lists, as JSON, JSONL or Markdown; capture only with --include-capture. Never overwrites.",
      examples: ["amem project export repo@1234abcd --to ./repo.json", "amem project export repo@1234abcd --to ./repo.json --include-capture"],
      options: { ...json("the export receipt"), "--to": path("Destination file, outside the memory home"), "--include-capture": flag("Also export capture rows, screened"), "--format": { description: "Portable format (default json)", value: ["json", "jsonl", "markdown"] }, ...policy },
      args: [{ name: "key" }] },
    import: { description: "Preview or re-import notes from a JSONL export", details: "Keeps the original entry ids.",
      examples: ["amem project import repo@1234abcd --from ./repo.jsonl", "amem project import repo@1234abcd --from ./repo.jsonl --confirm"],
      options: { ...json("the import preview or receipt"), "--from": path("JSONL project export"), "--confirm": flag("Write after the preview"),
        "--allow-shared": flag("Permit shared-scope notes from this file"), ...policy }, args: [{ name: "key" }], mutates: "confirm", policyFree: true },
    archive: { description: "Take a cold project out of recall", details: "An append-only op; unarchive brings it back.", examples: ["amem project archive repo@1234abcd"],
      options: json("the archive receipt"), args: [{ name: "key" }], mutates: true },
    unarchive: { description: "Bring an archived project back into recall", details: "An append-only op.", examples: ["amem project unarchive repo@1234abcd"],
      options: json("the unarchive receipt"), args: [{ name: "key" }], mutates: true },
    forget: { description: "Forget one project for good", details: "An append-only op; previews without --confirm.", examples: ["amem project forget repo@1234abcd", "amem project forget repo@1234abcd --confirm"],
      options: { ...json("the forget receipt"), "--confirm": flag("Record the forget after the preview") }, args: [{ name: "key" }], mutates: "confirm" },
    "keep-separate": { description: "Keep this directory's new project key apart", details: "Ends a project key transition without joining; previews without --confirm.",
      examples: ["amem project keep-separate", "amem project keep-separate --confirm"],
      options: { ...json("the keep-separate preview or receipt"), "--confirm": flag("Record the choice after the preview") }, mutates: "confirm" },
  } },
  show: { group: "read", description: "Show a note", examples: ["amem show abcdef12", "amem show abcdef12 --history"], options: { ...json("the note"), ...history }, args: [{ name: "id" }] },
  graph: { group: "read", description: "Show the graph around a note or node", examples: ["amem graph abcdef12", "amem graph abcdef12 --hops 2"],
    options: { ...json("the graph"), ...history, "--hops": { description: "Graph depth", value: ["1", "2"] } }, args: [{ name: "id-or-node" }] },
  suggestions: { group: "review", description: "List pending suggestions", examples: ["amem suggestions --json"], options: json("the suggestions") },
  confirm: { group: "review", description: "Confirm a suggestion", examples: ["amem confirm abcdef12"], options: json("the receipt"), args: [{ name: "id" }], mutates: true },
  reject: { group: "review", description: "Reject a suggestion", examples: ["amem reject abcdef12"], options: json("the receipt"), args: [{ name: "id" }], mutates: true },
  promote: { group: "write", description: "Promote a note, or copy it into the repository log",
    details: "With --to repo, appends the note's screened line to this repository's .amem/log.jsonl.",
    examples: ["amem promote abcdef12", "amem promote abcdef12 --to repo --confirm"],
    options: { ...json("the receipt"), ...policy, "--to": { description: "Promote into the repository scope", value: ["repo"] },
      "--confirm": flag("With --to repo: append the previewed line"),
      "--confirm-public": text("With --to repo: the entry id's first 8 characters", "Required unless the repository is verified private.") }, args: [{ name: "id" }], mutates: true, policyFree: true },
  repo: { group: "maintenance", description: "Show or set up this repository's memory log", details: "The repository scope is this repository's .amem/log.jsonl.", options: json("the repository status"), defaultCommand: "status", commands: {
    status: { description: "Show the repository log and what the screen withheld", examples: ["amem repo status --json"], options: json("the repository status") },
    attributes: { description: "Add the merge=union entry to .gitattributes", details: "For .amem/log.jsonl. Previews without --confirm; never committed.",
      examples: ["amem repo attributes", "amem repo attributes --confirm"], mutates: "confirm", options: { "--confirm": flag("Write after the preview") } },
  } },
  demote: { group: "write", description: "Demote a note", examples: ["amem demote abcdef12"], options: json("the receipt"), args: [{ name: "id" }], mutates: true },
  forget: { group: "write", description: "Forget a note", examples: ["amem forget abcdef12"], options: json("the receipt"), args: [{ name: "id" }], mutates: true },
  note: { group: "write", description: "Write curated notes through the configured policy", options: json("the new note id"), commands: {
    add: { description: "Add one curated note",
      details: "Text as arguments, - to type it until end of input, or no text to open $EDITOR. A fail note takes --approach, --symptom, --cause, --evidence (repeatable) and --retry-when.",
      examples: ["amem note add --kind decision Use one lock per home", "amem note add --kind fail --approach retry --symptom timeout -"], mutates: true,
      options: { ...json("the new note id"),
        "--kind": { description: "Note kind (default finding)", value: KINDS }, "--tier": { description: "Memory tier (default long)", value: ["short", "long"] },
        "--scope": { description: "Scope (default project)", value: ["project", "shared"] }, "--title": text("One-line title"),
        "--approach": text("fail: what was tried"), "--symptom": text("fail: what went wrong"), "--cause": text("fail: why"), "--evidence": text("fail: a reference (repeatable)"),
        "--retry-when": text("fail: when the approach is worth retrying") },
      args: [{ name: "text", variadic: true, optional: true }] },
  } },
  supersede: { group: "write", description: "Replace a note with a newer one", examples: ["amem supersede abcdef12 0123abcd"], options: json("the receipt"), args: [{ name: "old-id" }, { name: "new-id" }], mutates: true },
  rebuild: { group: "maintenance", description: "Rebuild the derived index", examples: ["amem rebuild"], options: json("the rebuild receipt"), mutates: true },
  dedupe: { group: "maintenance", description: "Preview duplicate reconciliation", examples: ["amem dedupe", "amem dedupe --apply"],
    options: { ...json("the reconciliation preview"), "--apply": flag("Append reconciliation operations") }, mutates: "apply" },
  sync: { group: "maintenance", description: "Sync with a private remote",
    details: "--if-due syncs only when the schedule and the failure backoff allow it; --force ignores both.",
    examples: ["amem sync", "amem sync --if-due"],
    options: { ...json("the sync result"), ...policy, "--remote": text("Private git URL"),
      "--if-due": flag("Sync only when due; stops after 30 seconds", "Due hourly after a success; after failures the wait starts at 15 minutes and doubles up to a day."),
      "--force": flag("With --if-due: ignore the schedule and backoff"),
      "--progress": { description: "Placement sync progress on stderr", value: ["auto", "human", "json", "off"],
        details: "auto prints human lines when stderr is a terminal and nothing otherwise; json prints one versioned event per line. stdout is unchanged." },
      "--status": flag("Show recorded placement sync operations", "Read-only: running, finished or interrupted operations. Opens no memory and takes no lock.") }, mutates: true, policyFree: true },
  machine: { group: "maintenance", description: "Show or label this machine", examples: ["amem machine", "amem machine --label laptop"], options: { ...json("the machine"), "--label": text("Machine label") }, mutates: "label" },
  import: { group: "write", description: "Import external memory", mutates: true, policyFree: true,
    options: { ...json("the import receipt"), ...policy, "--db": path("SQLite database file"), "--limit": number("Maximum observations"), "--restart": flag("Restart the import cursor"),
      "--capture-days": number("Also import recent days into capture") },
    commands: {
      "claude-mem": { description: "Import claude-mem observations", examples: ["amem import claude-mem", "amem import claude-mem --capture-days 7"],
        options: { ...json("the import receipt"), ...policy, "--db": path("SQLite database file"), "--limit": number("Maximum observations"), "--restart": flag("Restart the import cursor"),
          "--capture-days": number("Also import recent days into capture", "Imports recent claude-mem observations and summaries into capture.") } },
      "claude-auto": { description: "Import Claude Code auto memory as candidates", details: "CLAUDE.md and AGENTS.md stay excluded.", examples: ["amem import claude-auto"],
        options: { ...json("the import receipt"), ...policy, "--from": path("Claude projects directory (default ~/.claude/projects)"), ...claudeMemOnly } },
      codex: { description: "Import Codex memories as review candidates", details: "The originals stay unchanged.", examples: ["amem import codex"],
        options: { ...json("the import receipt"), ...policy, "--from": path("Codex memories directory (default ~/.codex/memories)"), ...claudeMemOnly } },
    } },
  goal: { group: "write", description: "Track long-term goals", options: json("the goals"), defaultCommand: "list", commands: {
    list: { description: "List goals", examples: ["amem goal list --all"], options: { ...json("the goals"), "--all": flag("Include completed goals") } },
    show: { description: "Show a goal", examples: ["amem goal show abcdef12"], options: json("the goal"), args: [{ name: "id" }] },
    new: { description: "Create a goal", examples: ["amem goal new Ship the sync checkpoint", "amem goal new --shared --milestone draft Write the spec"],
      options: { "--milestone": text("Milestone (repeatable)"), "--depends": text("Dependency goal ID (repeatable)"), "--shared": flag("Share across projects") }, args: [{ name: "title", variadic: true }], mutates: true },
    link: { description: "Link a goal to a host task board task", details: "Needs a host that has a task board; amem alone has none.", examples: ["amem goal link abcdef12 42"], args: [{ name: "id" }, { name: "task-id" }], mutates: true },
    state: { description: "Set a goal's state", examples: ["amem goal state abcdef12 blocked"], args: [{ name: "id" }, { name: "state", values: GOAL_STATES }], mutates: true },
    done: { description: "Complete a goal", examples: ["amem goal done abcdef12"], options: json("the promotion offer"), args: [{ name: "id" }], mutates: true },
    take: { description: "Take a goal lease", examples: ["amem goal take abcdef12", "amem goal take abcdef12 --force"], options: { "--force": flag("Override the prior lease") }, args: [{ name: "id" }], mutates: true },
  } },
  review: { group: "review", description: "Review machine-local memory candidates", options: json("the candidates"), defaultCommand: "list", commands: {
    targets: { description: "List notes to re-check, in priority order", examples: ["amem review targets --limit 10"],
      options: { ...json("the targets"), "--project": text("Current project or alias"), "--limit": number("Maximum targets (1..500, default 50)") } },
    list: { description: "List review candidates", examples: ["amem review list --status all", "amem review list --kind fail --json"], options: { ...json("the candidates"),
      "--status": { description: "Candidate status", value: ["pending", "accepting", "accepted", "rejected", "all"] },
      "--kind": { description: "Candidate kind", value: CANDIDATE_KINDS }, "--limit": number("Maximum candidates (1..500)"),
    } },
    accept: { description: "Accept one candidate through the memory policy", examples: ["amem review accept <full-candidate-id>"],
      options: { ...json("the accepted note"), ...policy, "--kind": { description: "Require the selected candidate kind", value: CANDIDATE_KINDS } }, args: [{ name: "full-candidate-id" }], mutates: true, policyFree: true },
    reject: { description: "Reject one candidate", examples: ["amem review reject <full-candidate-id>"], options: json("the receipt"), args: [{ name: "full-candidate-id" }], mutates: true },
    decide: { description: "Decide one candidate without a terminal",
      details: "Without --confirm it previews the candidate (stamped shown); with --confirm it accepts, rejects or defers it.",
      examples: ["amem review decide <full-candidate-id> accept", "amem review decide <full-candidate-id> reject --confirm"],
      options: { ...json("the decision"), ...policy, "--confirm": flag("Apply the previewed decision") },
      args: [{ name: "full-candidate-id" }, { name: "decision", values: ["accept", "reject", "defer"] }], mutates: "confirm", policyFree: true },
    walk: { description: "Walk the pending candidates one by one", details: "Accept, edit (as a new note), reject, skip or quit each one.", examples: ["amem review walk", "amem review walk --kind fail"], mutates: true,
      options: { "--kind": { description: "Candidate kind", value: CANDIDATE_KINDS } } },
  } },
  decay: { group: "review", description: "Preview demoting old notes no open goal protects", details: "Old live long-term notes. Apply only with --apply --confirm.",
    examples: ["amem decay", "amem decay --days 180 --apply --confirm"], mutates: "apply",
    options: { ...json("the decay preview"), "--days": number("Age in whole days (default 90)"), "--propose": flag("Queue unused-injection candidates for review"),
      "--apply": flag("Preview exact revisions", "Combine with --confirm to apply them."), "--confirm": flag("Apply the exact revision preview with --apply"),
      "--forget": flag("Forget instead of demoting", "The confirmation names this action.") }, args: [{ name: "id", variadic: true, optional: true }] },
  migrate: { group: "maintenance", description: "Preview or apply a memory home migration",
    details: "Generation, shard, public prune view and sync placement migrations. Each previews by default and applies only with --apply; --deactivate selects shared v1 explicitly.",
    examples: ["amem migrate --dry-run", "amem migrate --sync-placement --dry-run"], mutates: "apply",
    options: { ...json("the migration receipt"), "--apply": flag("Apply the previewed migration"), "--dry-run": flag("Read-only receipt (default; kept as an alias)"), "--generation": text("Explicit 32-hex generation ID"),
      "--resume": flag("Resume the recorded migration"), "--deactivate": flag("Select shared v1 without deleting a generation"),
      "--shards": flag("Migrate the curated home into shards", "Project and user shards."),
      "--public-prune-view": flag("Enable the v2 public prune view on a split", "Forward-only, on an active split."),
      "--sync-placement": flag("Activate placement sync on this memory home", "Forward-only. Previews by default and applies with --apply; no automatic migration or renewal."),
      "--list-remote": flag("List remote project refs outside the inventory", "By hash, outside the active inventory."),
      "--abandon": flag("Discard an interrupted placement attempt", "Pre-commit only. Initial activation requires both markers to match their original v2 bytes; realm admission requires --confirm."),
      "--admit": text("Admit one new curated project realm", "A realm that appeared after activation, into the same epoch. Previews without --apply."),
      "--from-remote": flag("Admit the named remote-only realm", "Uses the configured placement sync remote."),
      "--confirm": flag("Confirm the previewed abandonment or checkpoint"),
      "--checkpoint": flag("Preview a placement checkpoint", "Person-reviewed: preview by default, then --confirm --plan, --resume or --abandon."),
      "--checkpoint-on-bound": { description: "Preview the sync-run checkpoint opt-in", value: ["on", "off"], details: "Turns the home opt-in on or off; --confirm writes it to amem.config.json." },
      "--plan": path("Saved --checkpoint --json preview to confirm"),
      "--writer-root": path("Writer inventory install root (repeatable)", "An absolute amem install root; repeat it for the complete local writer inventory."),
    } },
  status: { group: "read", description: "Show the memory home, policy and migration state", examples: ["amem status", "amem status --verbose"],
    options: { ...json("the status object"), "--verbose": flag("Show static notes and history lines (human output only)") } },
  formats: { group: "maintenance", description: "Raise format floors in formats.json", commands: {
    raise: { description: "Preview or append a format floor record",
      details: "Previews the record and the writer inventory; appends it to formats.json only with --confirm. Refused while any known writer is below the floor.",
      examples: ["amem formats raise home 0.30.0", "amem formats raise home 0.30.0 --confirm"], mutates: "confirm",
      options: { ...json("the floor preview or record"), "--confirm": flag("Append the previewed record") },
      args: [{ name: "surface", values: ["home", "curated", "capture", "hook-spool", "candidates", "work-lists", "sync"] }, { name: "min-reader" }] },
  } },
  doctor: { group: "read", description: "Check this project's memory health, read-only",
    details: "Duplicates and stale notes, pending candidates, capture freshness per CLI, the brief's token cost, index equals rebuild, reader leases, the policy in effect, and ingest and sync cadence.",
    examples: ["amem doctor", "amem doctor --json"], options: { ...json("the doctor report"), "--verbose": flag("Show static notes and history lines (human output only)") } },
  prune: { group: "maintenance", description: "Plan or apply exact-entry expiry in a generation", examples: ["amem prune --dry-run --cutoff 2026-01-01", "amem prune --apply --plan plan.json"], mutates: true,
    options: { ...json("the prune plan or receipt"), "--cutoff": date("Canonical UTC expiry cutoff"), "--dry-run": flag("Print a local sealed plan without writes"),
      "--user": flag("Select the user shard after a curated split", "Default: the current project."),
      "--apply": flag("Apply the exact local plan"), "--plan": path("Sealed local plan JSON file") } },
  capacity: { group: "maintenance", description: "Report capture use and propose capture bounds", examples: ["amem capacity", "amem capacity --disk-share 0.05"],
    options: { ...json("the capacity report"), "--disk-share": number("Disk-share bound for the proposal (default 0.02)") }, commands: {
      apply: { description: "Write the proposed capture bounds", details: "To the home capture config, or with --split each shard's share of the global budget.",
        examples: ["amem capacity apply", "amem capacity apply --split --confirm"], mutates: true,
        options: { ...json("the written bounds"), "--disk-share": number("Disk-share bound for the proposal (default 0.02)"),
          "--cap-mb": number("Capture cap in MB"), "--retention-days": number("Capture retention in days"), "--confirm": flag("Write after the preview"),
          "--split": flag("Write each shard's share of the global budget", "To each shard's own config.") } },
    } },
  alias: { group: "maintenance", description: "Map project keys onto a canonical key", options: json("the alias ops"), defaultCommand: "list", commands: {
    list: { description: "List alias ops", examples: ["amem alias list --json"], options: json("the alias ops") },
    add: { description: "Map one key onto its canonical key", details: "An append-only op.", examples: ["amem alias add old@1234abcd new@5678abcd"], options: json("the alias op"), args: [{ name: "from-key" }, { name: "to-key" }], mutates: true },
    remove: { description: "Make an alias key resolve to itself again", details: "An append-only op; the latest op wins.", examples: ["amem alias remove old@1234abcd"], options: json("the alias op"), args: [{ name: "alias-key" }], mutates: true },
  } },
  completion: { group: "setup", description: "Print static shell completion", examples: ["amem completion zsh"], args: [{ name: "shell", values: ["zsh", "bash", "fish"] }] },
  help: { group: "setup", description: "Show help for a command", examples: ["amem help status"], args: [{ name: "command", variadic: true, optional: true }] },
  version: { group: "setup", description: "Show the version" },
};

export interface CompletionDefinition { path: string[]; options: Record<string, OptionDefinition>; args: ArgumentDefinition[]; children: string[] }
export function completionDefinitions(): CompletionDefinition[] {
  const rows: CompletionDefinition[] = [{ path: [], options: { ...GLOBAL_OPTIONS, ...ROOT_OPTIONS, ...COMMANDS.list!.options }, args: [], children: Object.keys(COMMANDS) }];
  // #590 H5: a command accepts its own options and the global ones, never a parent's. A group invoked bare also takes its
  // default child's options, because the parser runs that child. Every flag a handler reads is declared on its own entry.
  const walk = (commands: Record<string, CommandDefinition>, path: string[]) => {
    for (const [name, command] of Object.entries(commands)) {
      const next = [...path, name];
      const options = { ...GLOBAL_OPTIONS, ...command.options, ...(command.defaultCommand ? command.commands?.[command.defaultCommand]?.options : {}) };
      rows.push({ path: next, options, args: [...command.args ?? []], children: Object.keys(command.commands ?? {}) });
      if (command.commands) walk(command.commands, next);
    }
  };
  walk(COMMANDS, []); return rows;
}
export interface ParsedCommand { path: string[]; definition: CommandDefinition; options: Record<string, string | boolean>; positionals: string[]; rawArgs: string[] }
export class CommandUsageError extends Error { readonly exitCode = 2; }

/** Pure validation, shared definitions with help/completion; no store, files or network. */
export function parseCommand(argv: readonly string[]): ParsedCommand {
  const tokens = argv.flatMap(token => {
    const equals = token.startsWith("--") ? token.indexOf("=") : -1;
    return equals >= 0 ? [token.slice(0, equals), token.slice(equals + 1)] : [token];
  });
  const path: string[] = [], options: Record<string, string | boolean> = {}, positionals: string[] = [];
  let definition: CommandDefinition = { description: "amem", commands: COMMANDS };
  let available: Record<string, OptionDefinition> = { ...GLOBAL_OPTIONS, ...ROOT_OPTIONS, ...COMMANDS.list!.options };
  const commandIndexes = new Set<number>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.startsWith("--")) {
      const option = available[token];
      if (!option) throw new CommandUsageError(`unknown option ${token}`);
      if (option.value !== undefined) {
        const value = tokens[++i];
        if (value === undefined || value.startsWith("--")) throw new CommandUsageError(`${token} needs a value`);
        if (Array.isArray(option.value) && !option.value.includes(value)) throw new CommandUsageError(`${token} takes ${option.value.join(" or ")}`);
        options[token] = value;
      } else options[token] = true;
    } else if (definition.commands) {
      const child: CommandDefinition | undefined = Object.hasOwn(definition.commands, token) ? definition.commands[token] : undefined;
      if (!child) throw new CommandUsageError(`unknown command ${[...path, token].join(" ")}`);
      commandIndexes.add(i);
      definition = { ...definition, ...child }; path.push(token);
      // Child metadata inherits policy, but its command children belong only to that child.
      definition.commands = child.commands;
      available = completionDefinitions().find(row => row.path.join(" ") === path.join(" "))!.options;
    } else positionals.push(token);
  }
  if (!path.length) {
    const name = options["--version"] === true ? "version" : "list";
    path.push(name); definition = COMMANDS[name]!;
  }
  if (definition.defaultCommand && definition.commands) {
    const name = definition.defaultCommand; definition = { ...definition, ...definition.commands[name]!, commands: undefined }; path.push(name);
  }
  if (positionals.length > (definition.args?.length ?? 0) && !definition.args?.at(-1)?.variadic) throw new CommandUsageError(`too many arguments for ${path.join(" ")}`);
  for (let i = 0; i < positionals.length; i++) {
    const argument = definition.args?.[i];
    if (argument?.values && !argument.values.includes(positionals[i]!)) throw new CommandUsageError(`${argument.name} takes ${argument.values.join(" or ")}`);
  }
  if (path[0] === "setup" && options["--list"] === true && options["--help"] !== true
    && (positionals[0] !== "agy" || ["--apply", "--undo", "--root", "--adopt-current", "--verbose"].some(flag => options[flag] !== undefined))) {
    throw new CommandUsageError("usage: amem setup agy --list [--json]");
  }
  const allowed = path[0] === "version" && options["--version"] === true ? completionDefinitions()[0]!.options : completionDefinitions().find(row => row.path.join(" ") === path.join(" "))!.options;
  for (const name of Object.keys(options)) if (!allowed[name]) throw new CommandUsageError(`unknown option ${name} for ${path.join(" ")}`);
  const outputOptionIndexes = new Set<number>();
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "--color") { outputOptionIndexes.add(i); outputOptionIndexes.add(++i); }
    else if (tokens[i] === "--ascii") outputOptionIndexes.add(i);
  }
  const rawArgs = [...(path[0] === "goal" ? path.slice(1) : path), ...tokens.filter((arg, index) => arg !== "--policy-free" && !commandIndexes.has(index) && !outputOptionIndexes.has(index))];
  return { path, definition, options, positionals, rawArgs };
}

const valueLabel = (value: NonNullable<OptionDefinition["value"]>) => typeof value === "string" ? `<${value}>` : value.join("|");
const optionLabel = (name: string, option: OptionDefinition) => `${name}${option.value === undefined ? "" : ` ${valueLabel(option.value)}`}`;
const argLabel = (arg: ArgumentDefinition) => {
  const body = arg.values && arg.values.length <= 4 ? arg.values.join("|") : `<${arg.name}>`;
  const shown = arg.variadic ? `${body}...` : body;
  return arg.optional ? `[${shown}]` : shown;
};
const own = (row: CompletionDefinition) => Object.entries(row.options).filter(([name]) => !Object.hasOwn(GLOBAL_OPTIONS, name));
/** #590 H3: `amem <path> <required> [optional] [options]`; the flags are listed under `▸ Flags`, never inlined. */
export function usageLine(path: readonly string[]): string {
  const row = completionDefinitions().find(candidate => candidate.path.join(" ") === path.join(" "));
  if (!row || !path.length) return "amem <command> [options]";
  const command = lookupCommand(path)!;
  const args = command.commands && !command.defaultCommand ? ["<command>"] : row.args.map(argLabel);
  return ["amem", ...path, ...args, ...(own(row).length ? ["[options]"] : [])].join(" ");
}
export function lookupCommand(path: readonly string[]): CommandDefinition | undefined {
  let commands: Record<string, CommandDefinition> | undefined = COMMANDS, command: CommandDefinition | undefined;
  for (const name of path) { if (!commands || !Object.hasOwn(commands, name)) return undefined; command = commands[name]!; commands = command.commands; }
  return command;
}
/** The longest prefix of `argv` that names a command path; an option's value is never a command name. */
export function commandPath(argv: readonly string[]): string[] {
  const path: string[] = [], rows = completionDefinitions();
  let commands: Record<string, CommandDefinition> | undefined = COMMANDS, row = rows[0]!;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith("-")) { if (!token.includes("=") && row.options[token]?.value !== undefined) i++; continue; }
    if (!commands || !Object.hasOwn(commands, token)) break;
    path.push(token); commands = commands[token]!.commands;
    row = rows.find(candidate => candidate.path.join(" ") === path.join(" "))!;
  }
  return path;
}

const HELP_WIDTH = 80, LABEL_WIDTH = 28;
const section = (name: string, count?: number) => `\u25b8 ${name}${count === undefined ? "" : ` (${count})`}`;
/** #590 H4: one line per row; a label wider than the column puts its text on the next line at the same column. */
function described(rows: readonly (readonly [string, string])[]): string[] {
  const width = Math.min(LABEL_WIDTH, Math.max(...rows.map(([label]) => cellWidth(label))));
  return rows.flatMap(([label, description]) => cellWidth(label) > width
    ? [`  ${label}`, `  ${" ".repeat(width)}  ${description}`]
    : [`  ${label}${" ".repeat(width - cellWidth(label))}  ${description}`]);
}
const prose = (text: string) => wrap(text, HELP_WIDTH - 2, 0).map(line => `  ${line}`);
const GLOBAL_LINE = "  Global: --help, --color auto|always|never, --ascii";
const GROUP_TITLE: Record<CommandGroup, string> = { read: "Read", write: "Write", review: "Review", maintenance: "Maintenance", setup: "Setup" };

/**
 * #590 H2/H3: the grouped root overview, or one command's page (`▸ Usage`, `▸ Description`, `▸ Flags`, `▸ Commands`,
 * `▸ Examples`, `▸ Details`). An argv that names no command gets the overview; `amem help <unknown>` refuses in cli.ts.
 */
export function commandHelp(argv: readonly string[] = []): string {
  const words = argv.filter(word => word !== "--help" && word !== "-h");
  const path = commandPath(words);
  const command = path.length ? lookupCommand(path) : undefined;
  if (command && path[0] !== "help") {
    const row = completionDefinitions().find(candidate => candidate.path.join(" ") === path.join(" "))!;
    const flags = own(row);
    const lines = [section("Usage"), `  ${usageLine(path)}`, "", section("Description"), ...prose(command.description)];
    if (flags.length) lines.push("", section("Flags", flags.length), ...described(flags.map(([name, option]) => [optionLabel(name, option), option.description])));
    lines.push(GLOBAL_LINE);
    if (command.commands) lines.push("", section("Commands", Object.keys(command.commands).length),
      ...described(Object.entries(command.commands).map(([name, child]) => [name + (name === command.defaultCommand ? " (default)" : ""), child.description])));
    if (command.examples?.length) lines.push("", section("Examples"), ...command.examples.map(example => `  ${example}`));
    const details = [command.details, ...row.args.filter(arg => arg.values && arg.values.length > 4).map(arg => `<${arg.name}>: ${arg.values!.join(", ")}.`), ...flags.filter(([, option]) => option.details).map(([name, option]) => `${name}: ${option.details}`)].filter((item): item is string => !!item);
    if (details.length) lines.push("", section("Details"), ...details.flatMap(prose));
    return lines.join("\n");
  }
  const groups = (Object.keys(GROUP_TITLE) as CommandGroup[]).map(group => {
    const entries = Object.entries(COMMANDS).filter(([, item]) => (item.group ?? "setup") === group);
    return ["", section(GROUP_TITLE[group], entries.length), ...described(entries.map(([name, item]) => [name, item.description]))];
  });
  return [section("Usage"), "  amem <command> [options]", GLOBAL_LINE, "  Get started: amem status, then amem help <command>",
    ...groups.flat(),
    "", section("Details"),
    ...prose("--policy-free is accepted and ignored; the configured privacy policy applies. Agent-marked reads use the MCP privacy ceiling. Apply and confirm need no terminal; review walk and the note editor stay interactive.")].join("\n");
}
/**
 * #590 AC9: true when `line` is one complete amem command that parses against `COMMANDS`. `<id>`-style placeholders are
 * accepted as an argument value. Shared with setup's next steps (#425) so every `->` row is checked the same way.
 */
export function isAmemCommand(line: string): boolean {
  const words = line.trim().split(/\s+/);
  if (words[0] !== "amem" || words.length < 2) return false;
  try { parseCommand(words.slice(1).map(word => /^<[a-z-]+>$/.test(word) ? "placeholder" : word)); return true; }
  catch { return false; }
}

