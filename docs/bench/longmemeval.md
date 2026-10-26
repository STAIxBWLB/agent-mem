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

Capture's normal 2,000-character excerpt cap, private-span removal and secret redaction apply. The report counts clipped and changed excerpts. Temporary retention covers the full haystack, and the clock is the question's UTC date in both library and MCP. These are measurement settings; production defaults are unchanged. All three backends read identical stored rows:

- MCP: a real spawned `bun --smol bin/amem.js mcp`, initialized over JSON-RPC, then `amem_search` with limit 50. Its ordinary complete-row standalone policy remains enabled.
- Library: `MemoryStore.search` with capture enabled and limit 50.
- Plain BM25: SQLite FTS5 `bm25(fts)` over the same capture database, the runtime's query tokenizer, ascending score then row ID, limit 50. No tier or recency adjustment.

MCP's native index also includes the role/event field; the plain capture FTS indexes excerpts. MCP policy screening can therefore make its result set differ from the other paths. This comparison preserves the actual APIs rather than adding a policy bypass.

Session ranking compacts the first 50 returned turns to distinct sessions in first-occurrence order. Session recall_any/all@5/10 is binary per question. NDCG@10 uses binary relevance and `1/log2(rank+1)` discount; MRR uses the first relevant session in that returned session list. Turn recall@10 is the fraction of `has_answer` turns in the first ten raw hits. Questions without turn labels are excluded only from the turn metric. A failed backend contributes zero, with its failure reported separately.

These conventions differ from upstream's user-only indexing and method-0 DCG discount. The numbers are a baseline for this harness, not a directly comparable published LongMemEval score. The benchmark does not measure abstention accuracy or answer generation.

Each question has a 30-second total worker deadline, including seed and all three backends. Completed backend checkpoints survive a later failure; late or missing paths score zero. The owned worker process group is reaped before the next question. Worker peak RSS includes seeding, library, BM25 and the MCP controller; MCP child peak is separate. Linux reads VmHWM, while macOS also uses wait4. Unknown final RSS is reported as missing, never zero. Cleanup time is separate from retrieval wall time.

## Reproduction

Use a clean checkout of the runtime commit and a separate checkout containing this harness. Run S and M serially:

```sh
bun scripts/longmemeval.ts --input /tmp/longmemeval_s_cleaned.json --output /tmp/lme-s.json --source-root /absolute/main-checkout --variant S
bun scripts/longmemeval.ts --input /tmp/longmemeval_m_cleaned.json --output /tmp/lme-m.json --source-root /absolute/main-checkout --variant M
```

The report records dataset SHA-256, runtime commit, harness commit and source hash, Bun/platform, per-question metrics, failures, timing and RSS. JSONL checkpoints and a Markdown companion are written beside it. `--max-questions N` is a pilot and explicitly reports `complete: false`. The input is never rewritten. Source and harness changes during a run are refused. No benchmark download or full S/M run belongs in ordinary CI; the small synthetic metric/input/runner fixtures do.

## Evaluation tiers

The private AC4 corpus measures recall in the person's actual work, through both MCP and library; it gates P5 and changes to ranking or candidate selection. LongMemEval supplies an external retrieval tier, reported per release and for ranking or selection changes. Built-in and Korean `amem eval` sets remain the deterministic F14 regression gates in CI. VibeMemBench outcome evaluation is separate work tracked by #88; its harness is public, while its dataset is not yet published at this measurement date.

## First S/M results

Measured main `8a0f73f56235504fe39c48f15440f764b6f75ad4`, harness `11ae68960275fefe15e8732c10d6c9da3c6dfe50` (SHA-256 `f64668dfe3f4ac2f9fb480d3a998d473c2d7cf86191b58085ac45c89a170f1a0`), Bun 1.4.2 on Linux (DGX), 2026-10-27 KST. S and then M ran serially. Each completed all 500 questions: 470 eligible, 30 abstentions excluded, 470 successes per backend, zero failed paths and zero timeouts.

| Set | Type | Backend | N | Any@5 | All@5 | Any@10 | All@10 | NDCG@10 | MRR | Turn@10 |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| S | overall | mcp | 470 | 0.9532 | 0.7702 | 0.9745 | 0.8660 | 0.8680 | 0.8949 | 0.7606 |
| S | overall | library | 470 | 0.9532 | 0.7681 | 0.9745 | 0.8660 | 0.8676 | 0.8953 | 0.7617 |
| S | overall | bm25 | 470 | 0.9511 | 0.8128 | 0.9702 | 0.8936 | 0.8857 | 0.9037 | 0.7817 |
| S | knowledge-update | mcp | 72 | 1.0000 | 0.7361 | 1.0000 | 0.8611 | 0.8886 | 0.9681 | 0.7731 |
| S | knowledge-update | library | 72 | 1.0000 | 0.7222 | 1.0000 | 0.8611 | 0.8855 | 0.9657 | 0.7731 |
| S | knowledge-update | bm25 | 72 | 1.0000 | 0.9861 | 1.0000 | 0.9861 | 0.9826 | 1.0000 | 0.9051 |
| S | multi-session | mcp | 121 | 0.9587 | 0.6116 | 0.9835 | 0.8017 | 0.8338 | 0.8879 | 0.6515 |
| S | multi-session | library | 121 | 0.9587 | 0.6116 | 0.9835 | 0.8017 | 0.8340 | 0.8879 | 0.6515 |
| S | multi-session | bm25 | 121 | 0.9669 | 0.6198 | 0.9835 | 0.8099 | 0.8462 | 0.9020 | 0.6617 |
| S | single-session-assistant | mcp | 56 | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 0.9934 | 0.9911 | 0.8929 |
| S | single-session-assistant | library | 56 | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 0.9934 | 0.9911 | 0.9107 |
| S | single-session-assistant | bm25 | 56 | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 0.9911 | 0.9881 | 0.8929 |
| S | single-session-preference | mcp | 30 | 0.7000 | 0.7000 | 0.8000 | 0.8000 | 0.5764 | 0.5177 | 0.4944 |
| S | single-session-preference | library | 30 | 0.7000 | 0.7000 | 0.8000 | 0.8000 | 0.5764 | 0.5173 | 0.4944 |
| S | single-session-preference | bm25 | 30 | 0.6667 | 0.6667 | 0.8000 | 0.8000 | 0.5566 | 0.4934 | 0.4611 |
| S | single-session-user | mcp | 64 | 0.9844 | 0.9844 | 1.0000 | 1.0000 | 0.9760 | 0.9684 | 0.9531 |
| S | single-session-user | library | 64 | 0.9844 | 0.9844 | 1.0000 | 1.0000 | 0.9760 | 0.9684 | 0.9531 |
| S | single-session-user | bm25 | 64 | 0.9844 | 0.9844 | 1.0000 | 1.0000 | 0.9842 | 0.9792 | 0.9531 |
| S | temporal-reasoning | mcp | 127 | 0.9449 | 0.7480 | 0.9685 | 0.8189 | 0.8480 | 0.8699 | 0.7651 |
| S | temporal-reasoning | library | 127 | 0.9449 | 0.7480 | 0.9685 | 0.8189 | 0.8482 | 0.8726 | 0.7612 |
| S | temporal-reasoning | bm25 | 127 | 0.9370 | 0.7638 | 0.9528 | 0.8425 | 0.8499 | 0.8725 | 0.7664 |
| M | overall | mcp | 470 | 0.8830 | 0.6234 | 0.9170 | 0.7106 | 0.7415 | 0.7916 | 0.6577 |
| M | overall | library | 470 | 0.8830 | 0.6234 | 0.9191 | 0.7170 | 0.7428 | 0.7905 | 0.6599 |
| M | overall | bm25 | 470 | 0.8830 | 0.6979 | 0.9191 | 0.7723 | 0.7747 | 0.7981 | 0.7020 |
| M | knowledge-update | mcp | 72 | 0.9583 | 0.4722 | 0.9722 | 0.5833 | 0.7610 | 0.9175 | 0.6458 |
| M | knowledge-update | library | 72 | 0.9583 | 0.4722 | 0.9722 | 0.5972 | 0.7626 | 0.9175 | 0.6458 |
| M | knowledge-update | bm25 | 72 | 0.9861 | 0.8889 | 0.9861 | 0.9583 | 0.9247 | 0.9387 | 0.8426 |
| M | multi-session | mcp | 121 | 0.8843 | 0.4380 | 0.9339 | 0.5620 | 0.6745 | 0.7561 | 0.5182 |
| M | multi-session | library | 121 | 0.8843 | 0.4380 | 0.9339 | 0.5620 | 0.6744 | 0.7514 | 0.5182 |
| M | multi-session | bm25 | 121 | 0.8760 | 0.4711 | 0.9339 | 0.5868 | 0.6867 | 0.7632 | 0.5478 |
| M | single-session-assistant | mcp | 56 | 0.9821 | 0.9821 | 0.9821 | 0.9821 | 0.9690 | 0.9651 | 0.8571 |
| M | single-session-assistant | library | 56 | 0.9821 | 0.9821 | 0.9821 | 0.9821 | 0.9690 | 0.9651 | 0.8750 |
| M | single-session-assistant | bm25 | 56 | 0.9821 | 0.9821 | 0.9821 | 0.9821 | 0.9821 | 0.9834 | 0.8929 |
| M | single-session-preference | mcp | 30 | 0.4000 | 0.4000 | 0.5667 | 0.5667 | 0.3301 | 0.2632 | 0.3056 |
| M | single-session-preference | library | 30 | 0.4000 | 0.4000 | 0.5667 | 0.5667 | 0.3301 | 0.2631 | 0.3056 |
| M | single-session-preference | bm25 | 30 | 0.4000 | 0.4000 | 0.5667 | 0.5667 | 0.3508 | 0.2899 | 0.3278 |
| M | single-session-user | mcp | 64 | 0.9375 | 0.9375 | 0.9688 | 0.9688 | 0.8642 | 0.8313 | 0.8516 |
| M | single-session-user | library | 64 | 0.9375 | 0.9375 | 0.9844 | 0.9844 | 0.8689 | 0.8319 | 0.8516 |
| M | single-session-user | bm25 | 64 | 0.9531 | 0.9531 | 0.9688 | 0.9688 | 0.8770 | 0.8480 | 0.8828 |
| M | temporal-reasoning | mcp | 127 | 0.8819 | 0.6220 | 0.8976 | 0.7087 | 0.7295 | 0.7824 | 0.6950 |
| M | temporal-reasoning | library | 127 | 0.8819 | 0.6220 | 0.8976 | 0.7165 | 0.7309 | 0.7824 | 0.6950 |
| M | temporal-reasoning | bm25 | 127 | 0.8661 | 0.6220 | 0.8976 | 0.7008 | 0.7305 | 0.7650 | 0.6822 |

On S, MCP and library have equal session any@10/all@10. On M, MCP is slightly below library (any@10 0.9170 vs 0.9191; all@10 0.7106 vs 0.7170). Plain BM25 has higher all@10, NDCG and turn recall on both sets. These differences include the documented native indexing and policy differences; they do not isolate a single cause or justify changing ranking here.

| Set | Total seconds | Question median / max ms | Worker peak MiB | MCP child peak MiB | Stored rows | Over excerpt cap | Changed excerpts |
|---|---:|---:|---:|---:|---:|---:|---:|
| S | 183.87 | 362 / 472 | 50.8 | 59.5 | 231,606 | 47,155 | 47,162 |
| M | 841.07 | 1688 / 2247 | 108.5 | 80.5 | 2,299,951 | 460,458 | 460,579 |

Rows and resource summaries above cover the 470 evaluated questions, not the excluded abstentions. Total time also includes file hashing and streaming input; per-question time includes seeding and all three backends. These small per-question corpora are not a replacement for the separate 85K-row R3 volume budget. Per-question wall time/RSS and returned evidence IDs remain in the temporary JSON/Markdown reports.
