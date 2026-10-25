# P5 cutover from claude-mem to amem, and the P6 live week

Runbook for #13 P5 and P6. The person runs every command below in a terminal outside any agent session: the amem CLI refuses agent-marked shells, and the dotfiles retirement changes this machine's agent configuration.

## Before you start

- **amem installed at the released version**, the same one agent-hub pins (`bun add -g @staix/agent-mem@<version>`). Check it with `amem --version`.
- **Optional, recent claude-mem activity:** the bounded capture import (#13 design G) lands with hub task #11. Without it, only curated notes and `work_state` lists move; recent observations stay in the archived claude-mem home.
- **No agent session is writing memory** while you import, so the cursors read a stable source.

## P5 steps

- **Health check**
  - `amem doctor`: duplicates, stale entries, pending candidates, capture freshness per CLI, index equal to rebuild, policy in effect.
  - `amem status`: where the memory home is (default `~/.agenthub/memory`, movable with `AMEM_HOME`).
- **Register amem with every client**
  - `amem setup all` prints the plan and changes nothing. Read it.
  - `amem setup all --apply` asks for confirmation, then registers `amem mcp` and the hooks each client supports. `amem setup all --undo` reverses it byte for byte.
  - `dot ai memory install`, then `dot ai memory status`: dotfiles registers amem for the agents it manages and prints the lines for Claude Code and Codex.
- **Map claude-mem project keys** (#15 D2). claude-mem keys are often basenames (`agent-hub`, `work/dev/agent-hub`). Nothing merges on a name match.
  - `amem alias list` shows the existing aliases.
  - `amem alias add <claude-mem-key> <repository-key>` for each key you want carried over. `amem projects` lists the repository keys.
- **Import, once per repository.** The import is bound to the project of the directory it runs in, so run it from each repository checkout you want to carry over.
  - `amem import claude-mem` imports the hub-filed notes stored under that repository's name and the `work_state` lists of every claude-mem key aliased to it (a repository with no alias imports no work lists). It opens the claude-mem database read-only and reports read, added and skipped counts.
  - Run it again until it reports nothing new; `--limit` bounds one run and `--restart` resets the cursor and re-reads from the start (already-imported entries are not added twice).
- **Verify before retiring anything**
  - `amem search <a term you know>` shows the imported notes; they arrive as curated long-term notes, not as candidates.
  - `amem review list` shows any candidates agents proposed meanwhile; `amem review walk` goes through them one by one. Open work lists appear in the SessionStart brief of a new Claude Code session in that repository.
  - `amem doctor` again: no index drift, no unexpected policy skips.
- **Back up what the retirement changes.** Current dotfiles can no longer write the claude-mem LaunchAgents or bridge (dotfiles PR #296 removed them), so a rollback only works from copies taken now.
  - `dot ai memory retire-claude-mem > ~/claude-mem-retire-plan.txt` saves the dry run: every plugin, marketplace, MCP config file, LaunchAgent and directory it would touch.
  - Copy each file it lists into `~/claude-mem-backup-<date>/`, keeping the paths: the MCP config files, `~/Library/LaunchAgents/com.dotfiles.claude-mem-bridge.plist`, `~/Library/LaunchAgents/com.dotfiles.claude-mem-sync.plist` and `~/.claude/settings.json`.
  - Record the versions you would reinstall: `claude plugin list` and `codex plugin list` (the claude-mem plugin and its marketplace), and `dot --version`.
- **Retire claude-mem**
  - `dot ai memory retire-claude-mem` is a dry run: it lists the plugin, marketplaces, MCP entries, LaunchAgents and the home it would touch.
  - `dot ai memory retire-claude-mem --apply --import-complete` disables and uninstalls the plugin for Claude Code and Codex, removes the MCP entries for Kimi, Qwen, Antigravity, Kiro and Copilot, removes the `com.dotfiles.claude-mem-bridge` and `com.dotfiles.claude-mem-sync` LaunchAgents, and moves `~/.claude-mem` to `~/.claude-mem.archive-<date>`. It refuses while a claude-mem process runs.
  - Remove the lines it prints from `~/.claude/settings.json` yourself; dotfiles never edits that file.
- **Update the global agent instructions.** The "Persistent Memory" block of `~/.config/dotfiles/agents/AGENTS.md` still tells agents to query claude-mem. Rewrite it for amem (`amem mcp` tools for agents, `amem review` for the person), then run `dot ai agents apply`.
- **Read back**
  - `dot ai memory status` and the retirement's own read-back report no claude-mem process, port, hook or LaunchAgent.
  - `amem doctor` reports capture freshness for every CLI you use; a CLI without hooks shows as manual, so add `amem ingest <codex|kimi|pi>` to your session-end routine.

## Rollback

The retirement never deletes data, but current dotfiles cannot recreate what it removed. Roll back from the backup taken before retiring:

- Move `~/.claude-mem.archive-<date>` back to `~/.claude-mem`.
- Reinstall the claude-mem plugin and marketplace at the recorded versions with `claude plugin` and `codex plugin`.
- Copy the backed-up MCP config files and `~/.claude/settings.json` back to their paths.
- Copy the two plists back to `~/Library/LaunchAgents/` and load each with `launchctl bootstrap gui/$(id -u) <plist>`. Their programs came from the dotfiles release recorded above; if the current release no longer ships them, reinstall that recorded release first.
- `amem setup all --undo` removes the amem registrations. The amem home keeps everything it imported; nothing in it needs undoing.

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
  - Copy the directory that contains the memory home, for example `cp -R ~/.agenthub /tmp/amem-p6` when the home is `~/.agenthub/memory`. The script's `--home` takes that parent, not the `memory` directory itself.
  - Run `bun scripts/ac4-recheck.ts --home /tmp/amem-p6 --project <repository key>` from this repository (the default key is agent-hub's; `amem projects` lists the keys).
  - Check the printed `corpus`: it must be the number of curated entries you expect for that project. A `corpus` of 0 means a wrong `--home` or `--project`; fix them rather than record a result.
  - If the home was split into project shards (`amem migrate --shards`), the script cannot read it: it opens the single-home layout, which stops with "memory home has a curated split". Record the re-check as blocked on #13 and update the script to open the shard store before measuring.
  - Embeddings are revisited only if a match-mode gap remains after coverage improved.
- **Close-out.** Attach the daily readings and the re-check to #13, then tick AC2 and AC11. The dotfiles follow-up is dotfiles#255, implemented by dotfiles PR #296.
