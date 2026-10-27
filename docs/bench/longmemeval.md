# LongMemEval retrieval-only measurement

This external benchmark measures retrieval, not answer quality. It uses no reader model, generated answer or judge. It does not replace the private AC4 corpus or the built-in evaluation gates.

## Data and runtime

The [LongMemEval repository](https://github.com/xiaowu0162/LongMemEval) and [cleaned dataset](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned) are MIT licensed. Dataset revision: `98d7416c24c778c2fee6e6f3006e7a073259d48f`. Download the two JSON files to a temporary directory, outside this checkout. Data and per-question reports are not committed.

| Set | File | Bytes | SHA-256 |
|---|---|---:|---|
| S | longmemeval_s_cleaned.json | 277383467 | d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442 |
| M | longmemeval_m_cleaned.json | 2737100077 | 9d79e5524794a2e6900a3aa9cb7d9152c5a3e8319c9a87c25494ba1eacee495f |

Each set has 500 questions, including 30 abstentions excluded from retrieval metrics. A streaming schema scan counted 246,750 S turns and 2,446,993 M turns. Repeated session IDs are valid: 13 repeated entries in S and 1,182 in M. Every turn is retained; a cumulative ordinal within each session ID distinguishes repeated entries.

## Method

For every non-abstention question, a fresh worker creates a throwaway memory home and Git project. All haystack turns, including assistant turns, become capture rows through the measured runtime's CaptureStore. Only role, content and session date enter the rows. Question text, answer text, session IDs and gold labels do not enter the index. The question is used only as the retrieval query.

Capture's normal 2,000-character excerpt cap, private-span removal and secret redaction apply. The report counts clipped and changed excerpts. Temporary retention covers the full haystack, and the clock is the question's UTC date: library `opts.now` uses it and a measurement-only MCP preload freezes `Date.now` to the same value. Recency weighting is therefore measured at question time, while performance clocks and watchdogs remain real. These are measurement settings; production defaults are unchanged. All three backends read identical stored rows:

- MCP: a real spawned `bun --smol bin/amem.js mcp`, initialized over JSON-RPC, then `amem_search` with limit 50. Its ordinary complete-row standalone policy remains enabled.
- Library: `MemoryStore.search` with capture enabled and limit 50.
- Plain BM25: SQLite FTS5 `bm25(fts)` over the same capture database, the runtime's query tokenizer, ascending score then row ID, limit 50. No tier or recency adjustment.

MCP's native index also includes the role/event field; the plain capture FTS indexes excerpts. MCP policy screening can therefore make its result set differ from the other paths. This comparison preserves the actual APIs rather than adding a policy bypass.

The metric implementation ports [src/retrieval/eval_utils.py at upstream commit 9e0b455f4ef0e2ab8f2e582289761153549043fc](https://github.com/xiaowu0162/LongMemEval/blob/9e0b455f4ef0e2ab8f2e582289761153549043fc/src/retrieval/eval_utils.py): `dcg`, `ndcg`, `evaluate_retrieval` and `evaluate_retrieval_turn2session`. The TypeScript translation keeps their control flow and replaces NumPy operations with equivalent array operations. The port includes upstream's MIT notice.

Corpus IDs are `<session>_<cumulative ordinal>`. Session evaluation strips the final ordinal, widens `effective_k` over the raw ranked turns until k distinct sessions appear, then evaluates those raw turns. It never compacts away repeated sessions. Session recall_any/all@5/10 and `ndcg_any@10` come directly from that upstream evaluator. DCG gives both ranks 1 and 2 weight 1, then rank r weight `1/log2(r)`. NDCG counts every returned turn from a gold session as relevant, and builds its ideal from every corpus turn in gold sessions, including repeated SIDs.

Upstream oddity retained: `effective_k` can reach corpus size + 1 if the available ranking never contains k distinct sessions. With amem's limit 50, widening beyond those 50 hits adds no result, while the ideal still uses full-corpus relevances at that widened cutoff. The nominal `ndcg_any@10` label therefore does not mean ten raw turns or ten compacted session positions.

MRR and fractional turn recall@10 are additional harness metrics, absent from upstream `eval_utils.py`. MRR is the reciprocal raw returned-turn position of the first gold session, within the 50 returned turns. Turn recall@10 is the fraction of gold `has_answer` turns found in the first ten raw hits; missing turn labels produce null for that metric. Failed backends contribute zero and remain in denominators.

The input pipeline indexes all roles and applies amem's ordinary capture processing and MCP policy; upstream `run_retrieval.py` indexes user turns only. Gold comes from `answer_session_ids` and `has_answer`, rather than upstream's `answer` substring heuristic. The result section counts questions upstream would additionally ignore because they lack a user-side target; this harness keeps those answerable assistant-target questions. Abstentions are excluded. No answer generation or abstention accuracy is measured.

Each question has a 30-second total worker deadline, including seed and all three backends. Completed backend checkpoints survive a later failure; late or missing paths score zero. The owned worker process group is reaped before the next question. Worker peak RSS includes seeding, library, BM25 and the MCP controller; MCP child peak is separate. Linux reads VmHWM, while macOS also uses wait4. Unknown final RSS is reported as missing, never zero. Cleanup time is separate from retrieval wall time.

## Reproduction

Use a clean checkout of the runtime commit and a separate checkout containing this harness. Run S and M serially:

```sh
bun scripts/longmemeval.ts --input /tmp/longmemeval_s_cleaned.json --output /tmp/lme-s.json --source-root /absolute/main-checkout --variant S
bun scripts/longmemeval.ts --input /tmp/longmemeval_m_cleaned.json --output /tmp/lme-m.json --source-root /absolute/main-checkout --variant M
```

The report records dataset SHA-256, runtime commit, harness commit and source hash, Bun/platform, per-question metrics, failures, timing and RSS. JSONL checkpoints and a Markdown companion are written beside it. `--max-questions N` is a pilot and explicitly reports `complete: false`. The input is never rewritten. Source and harness changes during a run are refused. No benchmark download or full S/M run belongs in ordinary CI; the small synthetic metric/input/runner fixtures do.

## Evaluation tiers

The private AC4 corpus measures recall in the person's actual work, through both MCP and library; it gates P5 and changes to ranking or candidate selection. LongMemEval supplies an external retrieval tier, reported per release and for ranking or selection changes. Built-in and Korean `amem eval` sets remain the deterministic F14 regression gates in CI. VibeMemBench outcome evaluation is separate work tracked by #88; its harness is public, while its dataset was not yet published when checked on 2026-10-26.

## First S/M results

Measured main `8a0f73f56235504fe39c48f15440f764b6f75ad4`, harness `bba7b5e8f787f1e98dbd55819e94f0216eda78da` (SHA-256 `751689176fcbf6c2a62564786ec44db91242217641320462f767583c1bc2ad1d`), Bun 1.4.2 on Linux (DGX), 2026-10-27 KST. S and then M ran serially. Each completed all 500 questions: 470 eligible, 30 abstentions excluded, 470 successes per backend, zero failed paths and zero timeouts.

| Set | Upstream additional no-user-target exclusions | Repeated SID entries in evaluated questions |
|---|---:|---:|
| S | 51 | 12 |
| M | 51 | 1115 |

The no-user-target questions remain in this all-role capture evaluation. Repeated SID counts here cover evaluated questions; the full-input scan above also counts excluded abstentions.

| Set | Type | Backend | N | Any@5 | All@5 | Any@10 | All@10 | ndcg_any@10 | MRR (extra) | Turn@10 (extra) |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| S | overall | mcp | 470 | 0.9532 | 0.7702 | 0.9745 | 0.8660 | 0.5570 | 0.8916 | 0.7606 |
| S | overall | library | 470 | 0.9532 | 0.7681 | 0.9745 | 0.8660 | 0.5568 | 0.8916 | 0.7617 |
| S | overall | bm25 | 470 | 0.9511 | 0.8128 | 0.9702 | 0.8936 | 0.5670 | 0.8993 | 0.7817 |
| S | knowledge-update | mcp | 72 | 1.0000 | 0.7361 | 1.0000 | 0.8611 | 0.5695 | 0.9681 | 0.7731 |
| S | knowledge-update | library | 72 | 1.0000 | 0.7222 | 1.0000 | 0.8611 | 0.5706 | 0.9657 | 0.7731 |
| S | knowledge-update | bm25 | 72 | 1.0000 | 0.9861 | 1.0000 | 0.9861 | 0.6373 | 1.0000 | 0.9051 |
| S | multi-session | mcp | 121 | 0.9587 | 0.6116 | 0.9835 | 0.8017 | 0.5516 | 0.8852 | 0.6515 |
| S | multi-session | library | 121 | 0.9587 | 0.6116 | 0.9835 | 0.8017 | 0.5506 | 0.8839 | 0.6515 |
| S | multi-session | bm25 | 121 | 0.9669 | 0.6198 | 0.9835 | 0.8099 | 0.5540 | 0.8994 | 0.6617 |
| S | single-session-assistant | mcp | 56 | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 0.7715 | 0.9911 | 0.8929 |
| S | single-session-assistant | library | 56 | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 0.7703 | 0.9911 | 0.9107 |
| S | single-session-assistant | bm25 | 56 | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 0.7683 | 0.9866 | 0.8929 |
| S | single-session-preference | mcp | 30 | 0.7000 | 0.7000 | 0.8000 | 0.8000 | 0.2495 | 0.5016 | 0.4944 |
| S | single-session-preference | library | 30 | 0.7000 | 0.7000 | 0.8000 | 0.8000 | 0.2490 | 0.5010 | 0.4944 |
| S | single-session-preference | bm25 | 30 | 0.6667 | 0.6667 | 0.8000 | 0.8000 | 0.2439 | 0.4770 | 0.4611 |
| S | single-session-user | mcp | 64 | 0.9844 | 0.9844 | 1.0000 | 1.0000 | 0.5337 | 0.9677 | 0.9531 |
| S | single-session-user | library | 64 | 0.9844 | 0.9844 | 1.0000 | 1.0000 | 0.5337 | 0.9677 | 0.9531 |
| S | single-session-user | bm25 | 64 | 0.9844 | 0.9844 | 1.0000 | 1.0000 | 0.5390 | 0.9785 | 0.9531 |
| S | temporal-reasoning | mcp | 127 | 0.9449 | 0.7480 | 0.9685 | 0.8189 | 0.5449 | 0.8644 | 0.7651 |
| S | temporal-reasoning | library | 127 | 0.9449 | 0.7480 | 0.9685 | 0.8189 | 0.5450 | 0.8670 | 0.7612 |
| S | temporal-reasoning | bm25 | 127 | 0.9370 | 0.7638 | 0.9528 | 0.8425 | 0.5412 | 0.8634 | 0.7664 |
| M | overall | mcp | 470 | 0.8830 | 0.6234 | 0.9170 | 0.7106 | 0.4151 | 0.7855 | 0.6577 |
| M | overall | library | 470 | 0.8830 | 0.6234 | 0.9191 | 0.7170 | 0.4159 | 0.7843 | 0.6599 |
| M | overall | bm25 | 470 | 0.8830 | 0.6979 | 0.9191 | 0.7723 | 0.4318 | 0.7904 | 0.7020 |
| M | knowledge-update | mcp | 72 | 0.9583 | 0.4722 | 0.9722 | 0.5833 | 0.4474 | 0.9145 | 0.6458 |
| M | knowledge-update | library | 72 | 0.9583 | 0.4722 | 0.9722 | 0.5972 | 0.4506 | 0.9145 | 0.6458 |
| M | knowledge-update | bm25 | 72 | 0.9861 | 0.8889 | 0.9861 | 0.9583 | 0.5297 | 0.9337 | 0.8426 |
| M | multi-session | mcp | 121 | 0.8843 | 0.4380 | 0.9339 | 0.5620 | 0.3811 | 0.7463 | 0.5182 |
| M | multi-session | library | 121 | 0.8843 | 0.4380 | 0.9339 | 0.5620 | 0.3816 | 0.7416 | 0.5182 |
| M | multi-session | bm25 | 121 | 0.8760 | 0.4711 | 0.9339 | 0.5868 | 0.3910 | 0.7490 | 0.5478 |
| M | single-session-assistant | mcp | 56 | 0.9821 | 0.9821 | 0.9821 | 0.9821 | 0.6759 | 0.9648 | 0.8571 |
| M | single-session-assistant | library | 56 | 0.9821 | 0.9821 | 0.9821 | 0.9821 | 0.6787 | 0.9648 | 0.8750 |
| M | single-session-assistant | bm25 | 56 | 0.9821 | 0.9821 | 0.9821 | 0.9821 | 0.6924 | 0.9829 | 0.8929 |
| M | single-session-preference | mcp | 30 | 0.4000 | 0.4000 | 0.5667 | 0.5667 | 0.1172 | 0.2474 | 0.3056 |
| M | single-session-preference | library | 30 | 0.4000 | 0.4000 | 0.5667 | 0.5667 | 0.1182 | 0.2479 | 0.3056 |
| M | single-session-preference | bm25 | 30 | 0.4000 | 0.4000 | 0.5667 | 0.5667 | 0.1332 | 0.2807 | 0.3278 |
| M | single-session-user | mcp | 64 | 0.9375 | 0.9375 | 0.9688 | 0.9688 | 0.3855 | 0.8258 | 0.8516 |
| M | single-session-user | library | 64 | 0.9375 | 0.9375 | 0.9844 | 0.9844 | 0.3845 | 0.8260 | 0.8516 |
| M | single-session-user | bm25 | 64 | 0.9531 | 0.9531 | 0.9688 | 0.9688 | 0.3869 | 0.8444 | 0.8828 |
| M | temporal-reasoning | mcp | 127 | 0.8819 | 0.6220 | 0.8976 | 0.7087 | 0.3994 | 0.7773 | 0.6950 |
| M | temporal-reasoning | library | 127 | 0.8819 | 0.6220 | 0.8976 | 0.7165 | 0.3992 | 0.7774 | 0.6950 |
| M | temporal-reasoning | bm25 | 127 | 0.8661 | 0.6220 | 0.8976 | 0.7008 | 0.3935 | 0.7568 | 0.6822 |

Plain BM25 has higher all@10, ndcg_any@10 and fractional turn recall on both sets. MCP and library are close, with a small gap on M. These results record the actual APIs and their input/screening differences; this PR changes no production ranking.

| Set | Total seconds | Question median / max ms | Worker peak MiB | MCP child peak MiB | Stored rows | Over excerpt cap | Changed excerpts |
|---|---:|---:|---:|---:|---:|---:|---:|
| S | 180.79 | 356 / 408 | 50.8 | 61.2 | 231,606 | 47,155 | 47,162 |
| M | 833.73 | 1680 / 2131 | 106.7 | 81.7 | 2,299,951 | 460,458 | 460,579 |

Rows and resource summaries cover the 470 evaluated questions. Total time also includes file hashing, streaming input and metric aggregation; question time includes seeding and all three backends. These per-question corpora do not replace the separate 85K-row R3 budget. Per-question wall/RSS and returned evidence IDs remain in the temporary JSON/Markdown reports.

Metric verification: hand-computed fixture tests cover all four upstream functions, widen-k, repeated SIDs, truncated rankings and inclusive cutoffs. An independent seeded comparison against the pinned Python/NumPy source matched 500 cases and 4,000 values within 1e-12. NumPy was used only for this external verification, not added as a dependency.

## Recency and tier attribution (#102)

The gap was rechecked using the upstream-ported metrics. A fresh M baseline subset run on `8a0f73f` selected 211 knowledge-update/multi-session questions (193 eligible, 18 abstentions). Its ranked turn lists match the corresponding 211 questions of the full #28 M run exactly. Knowledge-update all@10 remains MCP 0.5833, library 0.5972 and plain BM25 0.9583; multi-session remains 0.5620, 0.5620 and 0.5868.

The measurement-only `scripts/longmemeval-ablation.ts` runs baseline, recency-off, tier-off and both-off serially. Each condition uses a fresh temporary Git worktree at the same runtime base and a fresh memory home per question. Version-checked source transformations affect only the two score implementations used by `MemoryStore.search` and MCP's screened index. Production gains no ranking switch. Provenance records the base, temporary runtime commit, source-file hashes, patch hash and driver hash. An absent or repeated source anchor refuses the experiment.

The complete dataset hash, explicit type selection, question order, session/turn labels, capture dates, question-date clock, capture normalization/retention, query tokenizer, result limit, screening, candidate bounds and plain BM25 control are fixed. Every run checks its corpus metadata and BM25 turn lists against baseline. The tier factor is constant 0.5 for this capture-only corpus, so tier-off should match baseline and both-off should match recency-off; deviations would need investigation, not a new attribution claim.

To reproduce the serial attribution matrix against the pinned runtime:

```sh
bun scripts/longmemeval-ablation.ts --input /data/longmemeval_m_cleaned.json --output-dir /data/new-ablation-run --base-commit 8a0f73f56235504fe39c48f15440f764b6f75ad4
```

The output directory must be new. It contains each condition's provenance, full report, per-question receipts and `matrix.json`. Run from a Git checkout with the pinned commit available. `--max-questions` is for a partial smoke only; it cannot establish the full attribution claim.

All four conditions completed 211 selected questions (193 eligible, 18 abstentions), with zero failed paths/timeouts. The original and rebased harness sources have identical content hashes; the measured driver SHA-256 is `44cecf5335b842d25314e14b8ff70e901b2847b592b01c5adb2a388fd1e9bc78`. Source runtime remains main `8a0f73f`. The M dataset SHA-256 is unchanged from the first result table.

| Condition | Type | MCP all@10 | Library all@10 | Plain BM25 all@10 | MCP ndcg_any@10 | Library ndcg_any@10 |
|---|---|---:|---:|---:|---:|---:|
| baseline | knowledge-update | 0.5833 | 0.5972 | 0.9583 | 0.4474 | 0.4506 |
| baseline | multi-session | 0.5620 | 0.5620 | 0.5868 | 0.3811 | 0.3816 |
| recency-off | knowledge-update | 0.9583 | 0.9583 | 0.9583 | 0.5269 | 0.5297 |
| recency-off | multi-session | 0.5868 | 0.5868 | 0.5868 | 0.3914 | 0.3910 |
| tier-off | knowledge-update | 0.5833 | 0.5972 | 0.9583 | 0.4474 | 0.4506 |
| tier-off | multi-session | 0.5620 | 0.5620 | 0.5868 | 0.3811 | 0.3816 |
| both-off | knowledge-update | 0.9583 | 0.9583 | 0.9583 | 0.5269 | 0.5297 |
| both-off | multi-session | 0.5868 | 0.5868 | 0.5868 | 0.3914 | 0.3910 |

Recency-off closes 100% of the observed all@10 gap in both subsets for both amem paths. Tier-off changes no ranked turn list; both-off matches recency-off. Plain BM25 changes no list in any condition. This attributes this capture-only gap to recency weighting; it says nothing about tier preferences on a mixed curated/capture corpus.

Two fixed candidates were checked using the same seeded evaluation library as `amem eval`, with no parameter search. A 0.5 recency floor uses the original curve's value at 30 days and preserves the first 30 days. Recency only as an exact score tie-breaker is the issue's second structural example. Both are disposable runtime patches at the same `8a0f73f` base. The floor wraps the library's recency expression in `Math.max(0.5, ...)` and caps the screened SQL age denominator with `min(2.0, ...)`. The tie candidate removes recency multiplication from the library's primary score, then compares recency only after equal primary scores and before the existing reference tie-breaker; screened SQL uses the equivalent `ORDER BY score DESC, recency DESC, ref`. Tier factors, candidate bounds and screening remain fixed.

| Candidate | Built-in MRR / hit@1 | Korean MRR / hit@1 | Held-out MRR / hit@1 |
|---|---:|---:|---:|
| Baseline | 0.9063 / 0.8750 | 0.8934 / 0.8684 | 0.8739 / 0.8378 |
| Floor 0.5 | 0.9063 / 0.8750 | 0.8956 / 0.8684 | 0.8739 / 0.8378 |
| Recency tie-breaker | 0.9063 / 0.8750 | 0.9167 / 0.8947 | 0.8892 / 0.8649 |

Both candidates lose no aggregate MRR, hit@1/5/10 or recall@1/5/10 on these sets. Floor 0.5 changes only one Korean question from rank 4 to rank 3; all built-in/held-out ranks are unchanged. The tie-breaker swaps built-in ranks 1 and 2 on two questions (aggregate unchanged), and improves three Korean and three held-out ranks. No fixture was edited.

The corrected #102 gate is the existing `scripts/f14-gate.ts` rule: a gain on every gate set (built-in and held-out), plus no loss on Korean, full LongMemEval S/M and the reviewer's private AC4 rerun. Neither fixed candidate passes F14: floor 0.5 changes neither gate set, while the tie-breaker gains only on held-out. Held-out was evaluated once for these predeclared candidates, never used for parameter tuning. The gate helper and curated-only evidence helper remain unchanged. Any revised admission rule needs the person's decision; these measurements do not authorize a production change.

Full S validation of floor 0.5 completed all 500 questions (470 eligible, 30 abstentions), with no failed path. Dataset, question/gold labels, stored-row metadata and every plain-BM25 turn list match the full baseline. It improves session all@10 from 0.8660 to 0.8894 for both amem paths, but fails the aggregate no-loss check on MRR:

| S metric | Baseline MCP | Floor MCP | Baseline library | Floor library |
|---|---:|---:|---:|---:|
| MRR | 0.89164005 | 0.89111676 | 0.89162377 | 0.89145626 |
| Temporal-reasoning MRR | 0.86437887 | 0.85745542 | 0.86700502 | 0.86008592 |

The S comparison checks session any/all@5/10, ndcg_any@10, MRR and turn recall@10 overall and by type. MRR is the only decreasing overall metric, with the decreases in temporal reasoning. Full M validation also completed all 500 questions (470 eligible, 30 abstentions), with zero failures and the same dataset/question/gold/stored-row/BM25 controls matching baseline for all 500. Session all@10 rises from 0.7106 to 0.7660 (MCP) and 0.7170 to 0.7681 (library), but overall MRR falls from 0.78547064 to 0.78463768 (MCP) and 0.78433128 to 0.78349631 (library). Temporal-reasoning MRR falls from 0.77734803 to 0.76882307 (MCP) and 0.77736005 to 0.76882765 (library); its ndcg_any@10 falls from 0.39939223 to 0.39759473 and 0.39921656 to 0.39853589, respectively. No other checked overall metric decreases. Thus floor 0.5 fails the no-loss condition on both S and M, independently of its F14 failure. The tie-breaker S run was interrupted after question 74 and supplies no completed S/M claim. No private AC4 rerun has been performed for either candidate; no production ranking change is included.
