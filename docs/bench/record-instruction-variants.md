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

Run `bun scripts/report-record-variants.ts --metrics FILE` against retained observations. Output includes numeric denominators, missing-counter coverage, invalid-selection counts and actual mean brief bytes. The rolling metrics tail cannot guarantee the entire seven-day week at 35 sessions per day; retain non-overlapping observations independently. Retention and all native resource limits are unchanged.

## Evidence status

The source S/M hashes have been verified against the documented originals. Full regression and variant-effect runs are pending; the implementation PR reports their final results and retained failures.
