# Record instruction variants

Issue #325 keeps A as the default while the person compares A and B during the #313 AC6 week. The public retrieval experiment below tests the format's retrieval effect using synthetic, gold-located Records. Natural writing effectiveness remains a live-week measurement.

## Inputs and provenance

Use the original S and M files and hashes listed in [LongMemEval](longmemeval.md). Keep clean, committed main and candidate checkouts and use one frozen candidate harness for every arm in a comparison.

`record-variant-fixture.ts` writes a new derived input and a provenance JSON file. It streams the source, retains all original turns and labels, and inserts at most two synthetic assistant Records per non-abstention question. Selection follows source order among turns with `has_answer: true` in an answer session. Each Record is inserted immediately after its source turn, has `has_answer: false`, and carries a deterministic normalized prefix of at most 225 source-text characters. Empty, secret-screened and parser-refused candidates are skipped and counted. Question and answer text do not supply the Record fact. Anchors identify the original session/turn position.

A uses that canonical Record line. B retains its fact, kind, anchor and position, adds `; basis:test`, and prefixes every second fixture Record with `? `. This transformation is fixed before measurements. The provenance records source/derived hashes and byte counts, script/dependency identity, question and Record counts, and skipped candidates.

## Comparisons

- **Regression:** original S and M on main and candidate, using identical inputs and the strict no-loss comparator.
- **Variant effect:** A and B on the candidate, using the same derived input. The opt-in seeding switch writes the selected Record text to the actual capture store used by library/MCP retrieval. Actual seed-form hashes are reported independently of the common input hash. A separate CaptureStore supplies canonical A content to the plain BM25 control in both arms. Gold, corpus positions, row metadata and harness remain comparable. The strict comparator is unchanged.

A failed or incomplete comparison remains evidence. Retain decreasing metrics and affected question ids; do not tune the text after observing a loss. Each complete public comparison contains 500 questions, including 30 excluded abstentions. Tiny fixture tests use explicit `--allow-fixture` and report their fixture scope.

Run the following for S, then repeat for M with the corresponding source file and `--variant M`. Output filenames must be new.

```sh
bun scripts/longmemeval.ts --input "$INPUT" --output "$OUT/s-main.json" --source-root "$MAIN_CONTROL" --variant S
bun scripts/longmemeval.ts --input "$INPUT" --output "$OUT/s-candidate.json" --source-root "$CANDIDATE" --variant S
bun scripts/record-recall-compare.ts --baseline "$OUT/s-main.json" --candidate "$OUT/s-candidate.json"
bun scripts/record-variant-fixture.ts --input "$INPUT" --output "$OUT/s-derived.json" --provenance "$OUT/s-derived-provenance.json"
bun scripts/longmemeval.ts --input "$OUT/s-derived.json" --output "$OUT/s-a.json" --source-root "$CANDIDATE" --variant S --record-variant a
bun scripts/longmemeval.ts --input "$OUT/s-derived.json" --output "$OUT/s-b.json" --source-root "$CANDIDATE" --variant S --record-variant b
bun scripts/record-recall-compare.ts --baseline "$OUT/s-a.json" --candidate "$OUT/s-b.json"
```

## Live counters

The person writes the private `record-instruction.json` selection file; `amem.config.json` retains its existing boolean-only `records` schema. Older readers ignore the separate file. See [the Record contract](../contracts.md) for selection and native metric units.

Run `bun scripts/report-record-variants.ts --input /path/to/memory/record-variants.jsonl` against the eight-day journal. Output includes numeric denominators, missing-counter coverage, invalid-selection counts and actual mean brief bytes. Age rewrites trigger past nine days and keep eight; ordinary appends use a bounded head probe, not a tail read. The journal has a 4 MiB hard cap; `window.capForcedTrim` reports a cap-forced loss of observations and makes coverage incomplete. The general resource-metrics tail and all native resource limits are unchanged. Selection accepts a current-uid, regular, single-link file with no group/other write bit, including 0644.

## Evidence

Measured implementation and harness: `d983635b771a39985d972de6434efcd4f68d2150`; frozen main control: `9a1792a0a05903afe23482329dcd83cc81cc9a31`, on Linux with Bun 1.4.2. All eight full-set arms completed 500 questions, with 470 successful retrieval paths and 30 excluded abstentions each. Each derived set contains 766 synthetic Records; no fixture candidate was skipped.

Original S and M regression comparisons both pass strict no-loss: all 98 deltas per set are zero, with identical MCP/library ordering. The Record-present A/B effect comparisons both fail. Full precision, all per-type rows, actual seed hashes, raw-report hashes and decreasing public question ids/scores are in [the aggregate evidence](record-instruction-variants-results.json). Raw reports and inputs remain outside the repository.

A-to-B overall deltas, rounded here to six decimals; the strict verdict uses full precision:

| Set | Backend | all@10 | nDCG@10 | MRR | turn recall@10 | Strict effect |
|---|---|---:|---:|---:|---:|---|
| S | MCP | 0 | -0.000222 | 0 | 0 | fail |
| S | library | 0 | -0.000049 | -0.001071 | 0 | fail |
| M | MCP | -0.002128 | -0.000309 | -0.000216 | 0 | fail |
| M | library | 0 | -0.000348 | -0.001664 | 0 | fail |

S has 14 decreasing aggregate rows and 21 public questions with a per-question decrease. M has 21 decreasing aggregate rows and 33 such questions. M question `73d42213` loses MCP all@10 (1 to 0); library question `6b7dfb22` loses MRR from 1 to 1/3. The common-input, gold, row, harness and fixed-BM25 guards passed.

AC3 is unmet. A remains the default, and no text, fixture or threshold tuning followed these results. This evidence does not establish live-week writing effectiveness or release readiness. Typecheck, boundary (162 source files), the 227 focused tests and pack (172 files) passed at the measured head. The final full suite finished with 3506 pass, 21 skip, two default 5-second sync-placement timeouts and one subsequent async error. Both timeout cases also occur on the source-identical, data-only control branch; their mechanism remains unattributed. The separate main/candidate/candidate/main GC diagnostic timed out on all four arms. No deadline, limit or assertion was widened. The aggregate evidence retains outcomes and log hashes.

## Retention and file-admission follow-up

At implementation head `2cb1848a82db5701759d8b1be56017f5a5e17ae9`, typecheck, boundary (163 source files), focused tests (43 pass, one uid/chown skip) and pack (173 files) pass. The full CI command `bun test --timeout 20000` passes with 3513 pass, 22 skip and zero failures across 3535 tests. The old default-5-second result above remains historical evidence. Production handler deadlines, resource limits and assertions are unchanged.

The separate numeric journal retains eight days within 4 MiB, leaving resource metrics unchanged; cap loss is explicit. Selection accepts regular, single-link, current-uid files without group/other write permission, including 0644. These changes do not alter the frozen public experiment or its failed strict no-loss result.
