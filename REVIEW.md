# Review contract

- Compare the complete diff with the linked issue and `AGENTS.md`. Account for documentation and generated fixtures as well as executable files.
- For memory implementation changes, apply the storage invariants in `AGENTS.md` and inspect the affected lifecycle, sync, import and incremental/rebuild regressions.
- For CLI changes, apply the person/TTY/privacy boundaries in `AGENTS.md`; verify refusal happens before store access and that reads cannot cause unauthorized promotion.
- For command or completion changes, compare the shared definitions, parser/help and shell candidates. Check path quoting and static generation; distinguish automated shell checks from manual interactive Tab evidence.
- For releases, check the package version, documented install commands, intended tarball contents and zero runtime dependencies. Keep npm credentials out of files and results; distinguish bootstrap publication from trusted-publisher evidence.
- Require successful typecheck, source-boundary and test checks at the reviewed head. Report platform skips and unverified live behavior explicitly.

## Passes and findings

- Run Bugs, Security, and spec/plan Compliance passes. For instruction files and prompts, also run Instruction prose: keep actionable rules, retain safety/permission boundaries, and move rationale to human documentation.
- Error messages: a new or changed error, refusal or failure message a person or agent sees names the cause (what failed and why) and the next step (the command, setting or target that fixes it). When secrets, ids or paths must stay out, it names the cause class and how to check it. A message missing either is a finding; Important when it is the only signal of a blocked action (a CLI exit, a refused tool call), otherwise a nit.
- Tag findings with pass, severity, evidence and provenance (introduced, pre-existing or indeterminate). Put pre-existing concerns in follow-up work rather than expanding the release.
- Reserve Important for broken behavior, data leaks or policy breaches. Treat style and naming as nits; report at most two nits and count the remainder.
- Skip generated-file formatting complaints, but review fixture compatibility and artifact correctness. There are no wholly excluded generated paths in this repository.
- Avoid duplicating failures already enforced by successful current-head CI (typecheck, import boundary and tests). Report coverage gaps, skipped live behavior and defects that those checks do not establish.
