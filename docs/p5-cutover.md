# P5 cutover from claude-mem to amem, and the P6 live week

Runbook for #13 P5 and P6. The amem CLI uses session markers for identity, screens agent-marked memory reads, and has no general marker refusal or TTY gate. The dotfiles retirement steps change this machine's agent configuration, so follow workspace authorization for those operations.

## Before you start

- **amem installed at the released version**, the same one agent-hub pins (`bun add -g @staix/agent-mem@<version>`). Check it with `amem --version`. Never install a version older than agent-hub's pin, even if an older `dot` recommends it.
- **A dot release that includes [dotfiles#300](https://github.com/STAIxBWLB/dotfiles/issues/300).** `dot ai memory status` must name the installed version shown by `amem --version`, without a version mismatch. An older `dot` can recommend a downgrade and overwrite registrations owned by amem; upgrade it before trusting its version guidance, and skip its registration command below until then.
- **A release that has `--capture-days`.** The bounded capture import (#13 design G, PR #76) shipped after 0.8.0; `amem import claude-mem --help` must list `--capture-days`. With an older release only curated notes and `work_state` lists move, and recent observations stay in the archived claude-mem home.
- **No agent session is writing memory** while you import, so the cursors read a stable source.

## P5 steps

- **Health check**
  - `amem doctor`: duplicates, stale entries, pending candidates, capture freshness per CLI, index equal to rebuild, policy in effect.
  - `amem status`: where the memory home is (default `~/.agenthub/memory`, movable with `AMEM_HOME`).
- **Register amem with every client**
  - `amem setup all` prints the plan and changes nothing. Read it.
  - **Claude Code, Codex, Kimi, Pi, Qwen and Jcode: amem only.** `amem setup all --apply` asks for confirmation, then registers `amem mcp` and the hooks each client supports. Jcode is MCP-only. Setup reports and skips missing clients; check that every client you use is available in the plan.
    - Kimi's default files are `~/.kimi-code/mcp.json` and `~/.kimi-code/config.toml`; Qwen's is `~/.qwen/settings.json`. Custom `KIMI_CODE_HOME` and `QWEN_HOME` change those roots. Do not overwrite these entries with another registering tool.
  - **Antigravity: amem only, per repository.** Run `amem setup agy` inside each repository to read its plan, then `amem setup agy --apply`. It writes `<repo>/.agents/mcp_config.json`; it is excluded from `all` and never registers a global entry.
  - **Kiro and Copilot: dot only.**
    - Before `dot ai memory install`, copy `~/.kiro/settings/mcp.json` and `~/.copilot/mcp-config.json`, if present, into `~/claude-mem-backup-<date>/pre-dot/`, keeping their paths (`pre-dot/.kiro/settings/mcp.json` and `pre-dot/.copilot/mcp-config.json`). Record which files did not exist.
    - Run `dot ai memory install`, then `dot ai memory status`, only with a released `dot` that includes dotfiles#300. With an older `dot`, skip `dot ai memory install`: it overwrites amem's Kimi and Qwen entries and adds a global Antigravity entry at `~/.gemini/config/mcp_config.json`, invalidating amem's undo receipts. Do not run dot's manual Claude Code or Codex registration lines after amem setup.
- **Map claude-mem project keys** (#15 D2). claude-mem keys are often basenames (`agent-hub`, `work/dev/agent-hub`). Nothing merges on a name match.
  - `amem alias list` shows the existing aliases.
  - `amem alias add <claude-mem-key> <repository-key>` for each key you want carried over. `amem projects` lists the repository keys.
- **Import, once per repository.** The import is bound to the project of the directory it runs in, so run it from each repository checkout you want to carry over.
  - `amem import claude-mem` imports the hub-filed notes stored under that repository's name and the `work_state` lists of every claude-mem key aliased to it (a repository with no alias imports no work lists). It opens the claude-mem database read-only and reports read, added and skipped counts.
  - Add `--capture-days N` to also bring the last N days of claude-mem observations and session summaries into the machine-local capture tier, for example `amem import claude-mem --capture-days 30`. It uses the same aliases, screens each full row before storing a bounded excerpt, follows the capture cap and retention, never reads Chroma vectors, and reports read, added, spooled and skipped. Capture rows are recall context only, never curated notes or evidence, and are not synced.
  - Run it again until it reports nothing new; `--limit` bounds one run and `--restart` resets the cursor and re-reads from the start (already-imported entries are not added twice). Choose N before the first run: widening it later reaches older rows only with `--restart`.
- **Verify before retiring anything**
  - `amem search <a term you know>` shows the imported notes; they arrive as curated long-term notes, not as candidates.
  - `amem review list` shows any candidates agents proposed meanwhile; `amem review walk` goes through them one by one. Open work lists appear in the SessionStart brief of a new Claude Code session in that repository.
  - `amem doctor` again: no index drift, no unexpected policy skips.
- **Back up what the retirement changes.** Current dotfiles can no longer write the claude-mem LaunchAgents or bridge (dotfiles PR #296 removed them), so a rollback only works from copies taken now.
  - `dot ai memory retire-claude-mem > ~/claude-mem-retire-plan.txt` saves the dry run: every plugin, marketplace, MCP config file, LaunchAgent and directory it would touch.
  - Copy each file it lists into `~/claude-mem-backup-<date>/`, keeping the paths: the MCP config files, `~/Library/LaunchAgents/com.dotfiles.claude-mem-bridge.plist`, `~/Library/LaunchAgents/com.dotfiles.claude-mem-sync.plist`, `~/.claude/settings.json` and `~/.config/dotfiles/agents/AGENTS.md`.
  - Save `dot ai agents apply --dry-run > ~/claude-mem-agents-plan.txt` and copy every rendered instruction file it lists (for example `~/.claude/CLAUDE.md`, the Codex, Kiro, Kimi, Pi, Qwen, Antigravity and Copilot targets) into the same backup.
  - Record the claude-mem plugin and marketplace versions with `claude plugin list` and `codex plugin list`.
  - Check whether the LaunchAgents can still run. Their programs are `dot ai memory bridge` and `dot ai memory sync` (`plutil -extract ProgramArguments json -o - <plist>` shows them). Run `dot ai memory bridge --help`. Since dotfiles PR #296 the installed `dot` no longer has those subcommands, so the two agents already fail on every run, and restoring their plists alone restores nothing.
  - **Gate:** if a rollback must bring the bridge back, install the last dotfiles release before PR #296 at a separate path and confirm `<that path>/dot ai memory bridge --help` runs before you retire anything. Otherwise accept that a rollback restores the plugin, MCP entries and home only, and write that down with the backup.
- **Retire claude-mem**
  - `dot ai memory retire-claude-mem` is a dry run: it lists the plugin, marketplaces, MCP entries, LaunchAgents and the home it would touch.
  - `dot ai memory retire-claude-mem --apply --import-complete` disables and uninstalls the plugin for Claude Code and Codex, removes the MCP entries for Kimi, Qwen, Antigravity, Kiro and Copilot, removes the `com.dotfiles.claude-mem-bridge` and `com.dotfiles.claude-mem-sync` LaunchAgents, and moves `~/.claude-mem` to `~/.claude-mem.archive-<date>`. It refuses while a claude-mem process runs.
  - Remove the lines it prints from `~/.claude/settings.json` yourself; dotfiles never edits that file.
- **Update the global agent instructions.** While amem is on PATH, every `dot ai agents apply` writes the amem memory block into `~/.config/dotfiles/agents/AGENTS.md`, drops the claude-mem block and renders all targets; do not run it before this step, or the cutover of the instructions happens early.
  - `dot ai agents apply --dry-run` must say it would write the amem memory block and drop the claude-mem block.
  - `dot ai agents apply`, then read back: the SSOT and each rendered target name amem and no longer tell agents to query claude-mem (`grep -c claude-mem <file>`).
- **Read back**
  - `dot ai memory status` and the retirement's own read-back report no claude-mem process, port, hook or LaunchAgent.
  - `amem doctor` reports capture freshness for every CLI you use; a CLI without hooks shows as manual, so add `amem ingest <codex|kimi|pi|qwen>` to your session-end routine.

## Rollback

The retirement never deletes data, but current dotfiles cannot recreate what it removed. Roll back from the backup taken before retiring:

- Move `~/.claude-mem.archive-<date>` back to `~/.claude-mem`.
- Reinstall the claude-mem plugin and marketplace at the recorded versions with `claude plugin` and `codex plugin`.
- Copy the backed-up MCP config files and `~/.claude/settings.json` back to their paths.
  - For Kiro and Copilot, restore the copies from `~/claude-mem-backup-<date>/pre-dot/`, not the later retirement backup. If a file was recorded as absent before dot installation, remove its newly created file if it contains no other configuration; otherwise remove only its `amem` server entry.
- Copy `~/.config/dotfiles/agents/AGENTS.md` and every rendered instruction file back from the backup. Do not run `dot ai agents apply` while amem is on PATH: it would write the amem block again and render it everywhere. Read back that the SSOT and each target contain the claude-mem block again. Run `dot ai agents apply` only after amem is uninstalled, or after a dotfiles change that lets you keep the claude-mem block.
- The bridge and sync agents come back only if you passed the gate above: point each backed-up plist's ProgramArguments at the pre-#296 `dot`, copy it to `~/Library/LaunchAgents/`, and load it with `launchctl bootstrap gui/$(id -u) <plist>`. Without that release, leave them out; they were not running before the cutover either.
- `amem setup all --undo` reverses only amem's registrations for Claude Code, Codex, Kimi, Pi, Qwen and Jcode, using its receipts. For Antigravity, run `amem setup agy --undo` inside each repository where you applied it. These commands do not undo dot's Kiro or Copilot registrations; restore their pre-dot state as above. The amem home keeps everything it imported; nothing in it needs undoing.

## P6 live week

Seven days of ordinary work with claude-mem retired. Record the start date on #13.

- **Daily**
  - `amem doctor --json` and `amem capacity --json`, saved with the date. Capacity reports the hook p95 and RSS the hooks recorded in `metrics.jsonl`, the search RSS, the capture growth and the proposed cap.
  - Note any regression: a missing recall, a slow hook, a refused command.
- **Resource readings (#13 AC2, live half)**
  - After each day's sessions end, `pgrep -fl amem` shows no amem process (R1).
  - Hook p95 and RSS from `amem capacity --json` stay under 150 ms and 100 MB (R2); MCP RSS under 100 MB idle and 200 MB during search (R3).
  - Disk: the size of the memory home against the capture cap.
- **Retrieval re-check (#13 AC4 follow-up).** On the last day, run the frozen 25-query set from `docs/p0-baseline.md` §3 against a copy, never the live home.
  - Copy only the memory home into a new parent, for example `mkdir /tmp/amem-p6 && cp -R ~/.agenthub/memory /tmp/amem-p6/memory` when the home is `~/.agenthub/memory`. The script's `--home` takes that parent (`/tmp/amem-p6`), not the `memory` directory itself.
  - Run `bun scripts/ac4-recheck.ts --home /tmp/amem-p6 --project <repository key>` from this repository (the default key is agent-hub's; `amem projects` lists the keys).
  - Check the printed `corpus`: it must be the number of curated entries you expect for that project. A `corpus` of 0 means a wrong `--home` or `--project`; fix them rather than record a result.
  - A home split into project shards with `amem migrate --shards --apply` is read through that project's shard; a single-layout home is read as before (#137).
  - Run it again with `--mcp` to measure the path that counted for P5: the script starts `amem mcp` with `AMEM_HOME` pointing at the copy and sends `tools/call amem_search { query, limit: 10 }` for each query, printing the same per-query shape plus `"path": "mcp"`. `amem mcp` takes its project from its working directory: the script uses a scratch git directory whose origin yields `--project`, or pass `--cwd <a checkout of that repository>` when it does not.
  - Copy only: the script refuses the live home (the one `AMEM_HOME` names, or the default `~/.agenthub/memory`) and a `--home` without a `memory` directory. Never point `--home` at the live parent.
  - Embeddings are revisited only if a match-mode gap remains after coverage improved.
- **Close-out.** Attach the daily readings and the re-check to #13, then tick AC2 and AC11. The dotfiles follow-up is dotfiles#255, implemented by dotfiles PR #296.
