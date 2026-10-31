# Purging an entry that leaked a secret or personal data

Use this when a note, capture row or candidate holds a secret or personal data that the privacy screen missed. It is the person's procedure built from existing commands (#188, option c of [the purge design](purge-design.md)). Nothing here runs automatically, and several steps cannot fully remove bytes; each says so.

Never paste the leaked value into a command line, an issue, a commit or a chat while doing this: use entry ids.

## 1. Rotate or revoke the secret first

Rotating or revoking the credential (or telling the affected person) is the only step that makes the leak harmless. Everything below only reduces where the text sits; none of it can recall a copy that already left the machine.

## 2. Hide it from every amem reader

```sh
amem forget <full-entry-id>
amem sync
```

`amem forget` masks the entry in every list, search, show, brief and MCP read on this machine. For a synced note the forget operation is synced too, so other machines hide it after their next `amem sync`. Its receipt lists the machine-local capture rows, candidates and work items in the same project that contain or overlap the forgotten text, by id and count only (never their text); you need them in step 4. `amem forget --json` gives the same list as `nearby`.

What this does **not** do: the authored row stays in the local log, in every derived index until it is rebuilt, and in the sync remote's Git history. `amem doctor` shows a `masked` row with the forget and prune counts as a reminder.

## 3. Local bytes, if they must go

**Default: accept that the masked row stays on disk.** Steps 1 and 2 already make the leak harmless and invisible to every amem reader. Rebuilding the home is lossy, and in a home that holds more than one project it puts every other project at risk. Do the rebuild below only if the bytes must leave this machine, and only after you have accepted the losses it lists.

A rebuild cannot carry over:

- lifecycle operations: supersede, demote, settle and forget are not exported, so the new home has the authored notes without them;
- capture rows, goals and work lists: `jsonl` export writes them, but `amem project import` does not read them back;
- notes that no project export selects, such as user-scope and shared-scope notes outside a project, and notes of a project you did not export;
- candidates, generation history, migration sources and sync state.

If you cannot accept a loss on that list, stop here and keep the masked row.

1. Stop every amem and hub process (hooks, `amem mcp`, agent-hub) so nothing writes to the home.
2. List **every** project in the home, archived and forgotten ones included:

   ```sh
   amem projects --all --json
   ```

3. Export each listed project, not only the affected one, to a directory outside the home:

   ```sh
   amem project export <project-key> --to /path/outside/home/<project-key>.jsonl --format jsonl
   ```

   Check each export's withheld counts: a row the privacy screen withholds is not in the file and will not be restored.
4. In the export that holds the leak, **delete** the leaked note's line. Do not edit it: `amem project import` recomputes each row's id from its content and refuses an edited row. Rows that point at the deleted one (a `supersedes` or `promotedFrom` relation) are refused too, because their target is no longer in the file; note their ids from the import preview and decide whether to delete them as well.
5. **Rename** the old home aside (do not delete it), start from a fresh empty home, and for each exported project recreate its aliases there (`amem alias add <from-key> <to-key>` for each alias in the export header; import refuses without them), then preview and import it:

   ```sh
   amem project import <project-key> --from /path/outside/home/<project-key>.jsonl
   amem project import <project-key> --from /path/outside/home/<project-key>.jsonl --confirm
   ```

   Check each preview's counts before `--confirm`; add `--allow-shared` only if the export holds shared-scope rows you mean to restore.
6. Compare `amem projects --all` and each project's note count in the new home with the old one. Keep the old home, untouched, until every project you need is restored and you have copied out anything on the loss list that you still need. Only then delete the old home and every export and backup (each holds the leak). A deleted file can still sit in filesystem snapshots or backups (step 6).

## 4. Machine-local tiers

These are outside the curated log and never synced. Use the ids from the forget receipt in step 2.

- **Capture** (`<home>/projects/<key-hash>/machine/<machine-id>/capture.db` and its `-wal`): recall context only. Deleting the project's capture shard directory removes all of its capture; it is rebuilt from new hook events and ingests. `amem gc --confirm` only evicts by age and cap, not by content.
- **Candidates** (`<home>/candidates.db`): review proposals. Reject listed pending candidates with `amem review reject <full-candidate-id>`; a rejected or accepted candidate's row stays in `candidates.db` until its retention removes it. Deleting `candidates.db` (with amem stopped) removes every candidate for every project; it is disposable.
- **Work lists** (`<home>/projects/<key-hash>/work/`): the forget receipt lists matching items as `work:<list>#<hash>`, where the hash is the first 12 hex characters of the SHA-256 of the task name. Work lists are append-only; closing an item hides it but keeps its line. Removing the bytes means removing the project's `work/` directory, which drops all of its work lists.
- **Exports**: delete every `amem project export` file that holds the row, including the one from step 3.
- **Derived indexes** (`index.db`, `search*.db`): `amem rebuild` regenerates them from the logs; SQLite can keep old text in free pages and the WAL until the file is rebuilt or vacuumed, so a fresh home (step 3) is the reliable way to drop it.

## 5. The sync remote

The remote keeps every published row in its history, and amem refuses a rewritten history by design: shard sync reports "remote history is not fast-forward" and generation sync reports "legacy main history is not fast-forward". Two ways out:

- **New remote (recommended):** create a new private repository, point a cleaned home at it with `amem sync --remote <new-private-url>`, then delete the old repository at the host. Every other machine must also move to the new remote.
- **Rewrite in place:** run `git filter-repo` on a fresh clone of the remote to drop the row, force-push, then re-clone the sync state on every machine. amem will refuse the rewritten history on any machine that still holds the old one.

Hosts can keep unreachable objects, reflogs, forks, pull-request refs and caches after either path; ask the host to purge them if it offers that.

## 6. What stays out of reach

No command reaches: machines that are offline or never sync again; export files copied elsewhere; filesystem snapshots, Time Machine and other backups; agent transcripts, chat logs and terminal scrollback that showed the text; and copies the Git host retains. Treat the secret as exposed (step 1) regardless.

See [the purge design](purge-design.md) for the full inventory and why amem does not rewrite log lines.
