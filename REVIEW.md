# Review contract

- Compare the complete diff with the linked issue and `AGENTS.md`. Account for documentation and generated fixtures as well as executable files.
- For memory implementation changes, apply the storage invariants in `AGENTS.md` and inspect the affected lifecycle, sync, import and incremental/rebuild regressions.
- For CLI changes, apply the person/TTY/privacy boundaries in `AGENTS.md`; verify refusal happens before store access and that reads cannot cause unauthorized promotion.
- For command or completion changes, compare the shared definitions, parser/help and shell candidates. Check path quoting and static generation; distinguish automated shell checks from manual interactive Tab evidence.
- For releases, check the package version, documented install commands, intended tarball contents and zero runtime dependencies. Keep npm credentials out of files and results; distinguish bootstrap publication from trusted-publisher evidence.
- Require successful typecheck, source-boundary and test checks at the reviewed head. Report platform skips and unverified live behavior explicitly.
