# Memory correctness audit (#326)

Retrieval is already measured: `amem eval` reports recall@k and MRR, and `docs/bench/longmemeval.md` records external retrieval baselines. None of that asks whether a stored note is still *right*. This audit measures that rate - the share of a sample that is correct, and what the rest is - so a review pass has a baseline to improve and an after-measure to compare against. It is the baseline for agent-hub#1329.

Judging happens outside amem. amem draws the sample, records where each note's anchors stand, writes a private sheet and later turns filled labels into counts. It makes no model call and no network call: the only outside read is the project's own read-only git history over the anchors.

## Protocol

1. **Sample** - draw a seeded, stratified sample of the project's curated notes:

   ```sh
   amem eval audit sample --project <key> --n 40 --seed 2026-11-20 --as-of 2026-11-20
   ```

   The draw stratifies by kind (`decision`, `finding`, `contract`, `fail`) and by age (`<30`, `30-90`, `>90` days). Every non-empty kind/age cell is represented before any cell gets a second note; the remainder goes to the cells with the most members left to offer, and ties break on the stratum name. The cells themselves are drawn in seeded order, so a different seed reaches different strata rather than always the first ones. `--seed` is required, and there is no `Math.random` anywhere in the draw: the same store, seed and as-of draw the same notes in the same order on any machine (`--n` beyond the frame draws the frame).

   The ages are measured at one explicit instant, `--as-of` (a canonical UTC date or timestamp, defaulting to today and recorded in the sheet as `asOf`). It is an input because a bucket is a property of a note at the moment it is sampled: two days later, a note 29 days old has moved from `<30` to `30-90` and can be drawn differently. Replaying a draw is therefore a command, not a hope: repeat `--seed` with the `asOf` the earlier sheet recorded and the same unchanged store draws the same notes in the same order - no wall clock is read on that path. A future instant is refused, because it would measure ages that have not happened and drop notes out of every bucket. A frame with nothing to draw is refused with its cause and the next step - an empty frame, or every candidate withheld by the configured policy - rather than a sheet of no notes that `score` cannot parse.

   `preference` notes (#370) are not sampled. A preference states a person's taste, so there is no source to check it against and the rubric's `unverifiable` would absorb the whole class and blur the rate that matters here - the same reason preferences stay out of decay review and consolidation. Flipping the decision is one line: add `"preference"` to `AUDIT_KINDS` in `src/memory/eval.ts`, the frame this sample reads.

2. **Judge** - open the sheet and fill `judge_a` and `judge_b`. Two judges are not required, but kappa needs both columns on the same notes. A judge is a person, or an agent in a separate session with its own access to the repository; a label is one of:

   | Label | Rubric |
   | --- | --- |
   | `correct` | true now, and true when it was written |
   | `stale` | once true, no longer true |
   | `wrong` | never true |
   | `unverifiable` | no source available |

   The sheet carries the rubric in its header, so a judge does not need this file. A judge cell is filled with one of those four words or left empty: a sentence in a cell is refused, because the score is content-free and a comment would have nowhere to go.

3. **Score** - turn the labels into content-free counts:

   ```sh
   amem eval audit score <sheet> --json
   ```

   The output holds the label totals, the same counts split by kind, age bucket and anchor status, the joint cross-tab of those three against the label as its non-zero cells, the sample frame size, the as-of instant the ages were measured at, and Cohen's kappa over the notes both judges labelled. A question like "how many stale `finding` notes older than 90 days have missing anchors" takes the joint cells; the three marginals beside them answer one attribute at a time. The project is named only by a SHA-256 prefix of its key, never by the key: a project key can be derived from a local checkout path, and the score is the part meant to be shared.

   It holds no note text, no title, no path and no entry id - not by a search for note content but because no note field is copied at all: the project becomes a digest, the clock becomes the canonical stamp the sheet recorded, and every other string in the result is a schema or field name, a member of one of four closed vocabularies, or the seed.

   **The seed is echoed verbatim; it is chosen by the person and is not note content** (owner ruling, 2026-11-20). It is the person's own input in the closed `[A-Za-z0-9._-]` alphabet, and the score has to name it so two runs can be compared - so a note whose whole text happens to equal the seed is not a leak, and the score keeps the seed rather than policing it away. That is the one exception; every other field is note-free, which is what the next paragraph enforces. The score refuses a sheet whose kind, age bucket or anchor status is outside its vocabulary, whose as-of is not a canonical UTC instant, whose seed is outside the sample alphabet, or whose judge cell is outside the four labels, so a hand-edited sheet cannot turn a sentence into a key.

## Anchor status

Each sampled note carries the anchors it names (its `path:` about nodes, at most eight, never an absolute path or a `..` segment) and, for each, where that anchor stands in the work tree the sample ran in:

- `present` - the path exists and no commit has touched it since the note was written;
- `changed since note time` - the path exists and at least one commit touched it after the note's timestamp (`git log --since <note time> -- <path>`);
- `missing` - the path does not exist now;
- `unavailable` - the anchor exists but the audit could not check it: the history read failed or timed out, or the path resolves outside the work tree (a symlink inside the repository can point anywhere, and the audit reads only this repository).

The sheet and the score spell that second state `changed`; it is this document's `changed since note time`.

A note's own status folds those: any `missing` anchor makes it `missing`, else any `changed` makes it `changed`, else any `unavailable` makes it `unavailable`, else `present`. So `present` always means the check ran and found nothing, never that it could not run. A note that names no path anchor is `none` - no check applies, and a high `none` share is itself a finding about how the notes are written. Status is a hint for the judge, never a verdict: a rename reads as `missing`, a comment-only edit reads as `changed`, and a note can be `correct` while its anchor moved. The audit needs a git work tree; run it from the project the notes describe, and it refuses otherwise, naming that next step.

## The sheet

The sheet is private and local: written `0600` under `eval/` in the memory home (or `--out <path>`), never overwritten, never part of a shard segment, never synced and never committed. It holds what the notes say, so treat it as note content: the score is what may be shared - quote counts and kappa, not the sheet. `frame` is the size of the frame the sample was drawn from, `drawn` is how many notes it holds, and `withheld` counts frame members the configured policy refused. The frame is read from one listing bounded at 20,000 live notes; a project larger than that reports `truncated`, and its `frame` is a floor rather than a count.

The configured policy (the machine file narrowed by the repository's `.amem/config`) screens every sampled note before the sheet's first write, for a person and an agent-marked session alike: a note whose text names a secret, personal data, a denied path or a configured pattern is withheld - counted, never copied - so the sheet cannot carry what the policy refuses to let leave the home. It screens the complete note view, not the fields the sheet happens to copy, so a denied pattern in `task`, `peer` or `source` withholds the note just as one in its text does.

A sheet is re-scoreable anywhere, and only re-checkable where it was drawn: anchors are work-tree relative, and `root` records the tree they were read in.

## Kappa

Cohen's kappa is the observed agreement between the two judges corrected for what chance alone would give. It is `n/a` - null, never `0` - when there is nothing to measure: no note carries both labels, or both judges used one single label throughout, where the chance term is 1. Read it as judge agreement, not as note quality: two judges agreeing on a wrong label still score high. With one judge, report the label distribution and say kappa was not computed.

## Using it around a review run

- **Before:** sample with a recorded seed, judge, and record the label distribution and kappa in the review's own notes.
- **After:** sample again with a different seed over the same project (a second seed is a check that the first sample was not one lucky stratum), judge with the same rubric, and compare the distribution - not the raw count, which moves with `--n`.
- Report the frame, `--n`, the seed and the anchor-status split with every result. A sample of 40 notes from a frame of 60 is nearly a census; one from a frame of 6,000 has wide error bars, and neither says anything about notes the sample did not draw.

## What this does not measure

Ranking is unchanged and unmeasured here (`amem eval` still does that). The audit says nothing about whether a note is *findable*, whether the capture tier is accurate, or whether a `stale` note was ever trusted - only whether what a sample of curated notes says is still true, as two judges read it.

## Checks

The audit's own behaviour is pinned by `test/eval-audit.test.ts`: the same store, seed and as-of draw the same sample and the sheet records that instant, while a note crossing a bucket boundary changes strata (AC1); the score carries no note content at any length, the seed is its only echoed string, and a sheet with a foreign kind, a bad seed, a non-canonical as-of or a sentence in a judge cell is refused (AC2); kappa matches a hand-worked fixture and the joint cross-tab names intersections the marginals cannot rebuild (AC3); an uncheckable anchor is `unavailable` rather than `present`, and an escaping symlink is recognised without reading anything outside the tree, so an existing and a missing external target report the same status; a note the configured policy refuses never reaches the sheet, in a marked session and in a person's run; an empty frame and a policy that withholds the whole frame are refusals with their cause, and a sheet is never overwritten or read past its bound without naming the next step; the audit kind frame is its own literal, not an alias of the eval-set kinds; and the module adds no model or network surface while the only process it runs is the hardened read-only `git` runner (AC4).
