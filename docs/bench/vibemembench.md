# VibeMemBench

## Adapter

This completes the adapter contract in [issue #88](https://github.com/STAIxBWLB/agent-mem/issues/88), step 1. The adapter and its synthetic tests live in a scratch harness checkout on dgx02. No harness code is vendored into amem, and amem's production source is unchanged. This section reports integration checks only; it contains no pilot or solver results.

### Frozen inputs and source

| Input | Revision |
| --- | --- |
| [DAMO-ConvAI harness](https://github.com/AlibabaResearch/DAMO-ConvAI/tree/faf754671f5b850e1b4d1ff870db37a6a2480df6/VibeMemBench) | `faf754671f5b850e1b4d1ff870db37a6a2480df6` |
| Scratch adapter commit, based on that harness | `ff6d3e0a9feb2d2147ec7999cb9da784744ad166` |
| amem runtime | `6d557ad6c9df158d25e312f9f751b37fc0d2499a` |
| [Public dataset](https://huggingface.co/datasets/Tongyi-ConvAI/VibeMemBench/tree/11164976b4f920cdb0d0cd570ca572e49acea1e8) | `11164976b4f920cdb0d0cd570ca572e49acea1e8` |

The Hugging Face revision API, read on 2026-10-27, reports a public dataset, Apache-2.0, last modified `2026-10-19T08:54:46.000Z`. The earlier blocked-on-data issue comment is stale. The initial synthetic adapter checks did not download the dataset; the later build correction below uses the public data already present on dgx02. The adapter contract comes from the pinned `scripts/memory_interface.py`, `scripts/memory_systems/demo.py`, `scripts/CONTRACT.md`, and `scripts/run_memory.py`.

Source delivery is retained on dgx02 under `~/code-src/`, outside this repository:

- Checkout: `vibemembench-amem-88`, branch `amem-adapter-88`; the baseline adapter receipt is the scratch commit above, and the current probe head is recorded below.
- Adapter: `VibeMemBench/scripts/memory_systems/amem.py`; SHA-256 `9eb3649f7e3b11e8b2ca12bbc0c05deb8071dad989aaba5065c8028f7513f9e5`.
- Synthetic checks: `VibeMemBench/scripts/test_amem_adapter.py`; SHA-256 `10c244dd8392ba1b39a85de5a8977e4e360b99cd1d5b0547cf1bb5b052595d48`.
- Fix patch against the retained run-only commit `a5192e0c03ae6ed91628a46b364fe27010b73639`: `amem-adapter-88-fix.patch`; SHA-256 `1c46c65b3e94be59b345be6b224b3727a3b0e806a8d5b13b523d1e4990037187`. That run-only commit remains an ancestor, unchanged.
- Incremental Git bundle: `amem-adapter-88-fix.bundle`; SHA-256 `73e04beb18f2a3de085777acb41c0af46958512b0348fd303ab548b7f69a7368`. `git bundle verify` passed; it requires the retained `a5192e0` commit. The original `amem-adapter-88.bundle` remains available for the initial adapter source.
- Runtime checkout: `amem-runtime-88`, detached at the amem revision above. The adapter refuses a different HEAD or a tracked change under `src/`.
- Initial check transcript: `amem-adapter-88-checks.log`; correction evidence is described below.

The scratch source and patch are the delivered adapter, not code shipped in the amem package. Keep them for the reviewer's subsequent pilot. The adapter has no Python package dependencies beyond the standard library and the harness interface. The synthetic harness test imports pandas 2.2.3 because `run_memory.py` imports it; it uses no parquet reader, model client, or dataset loader.

### Add and search behavior

- `MEMORY_SYSTEM = AmemMemorySystem` implements the no-argument constructor and synchronous `add(session, *, scope)` / `search(query, *, scope, top_k)` signatures.
- Each instance owns a fresh temporary root. Each exact `MemoryScope.user_id` gets its own amem home and SHA-256-derived project key. Conflicting scope metadata under an existing user_id is refused. A new instance starts empty even for an identical user_id. Explicit close and garbage collection remove its temporary homes.
- `add()` accepts only an earlier history session from the scope's repository, using the authoritative integer metadata check `issue_number < target_issue_number`. Repository prefixes parsed from the final numeric ID suffix are compared case-insensitively against the scope repository; parsed numbers check metadata consistency. Self, future and other-repository histories are still refused. It pairs assistant commands from `extra.actions` or `tool_calls` with their tool output by `tool_call_id`. It also captures ordinary message text and historical `exit.extra.submission` (falling back to exit content). No trajectory command is executed. No fix-span extraction or synthesis is added.
- Rows use `CaptureStore.append` with deterministic receipts. Identical replay is idempotent; conflicting replay of one session is refused. A spooled append is an error, so success means immediately searchable. The usual secret/private-span handling and capture excerpt ceiling remain in force.
- History has issue ordinals rather than actual PR dates. All rows therefore use the same declared synthetic timestamp, `2000-01-01T00:00:00.000Z`, with a stopped search clock at `2000-01-02T00:00:00.000Z`. Recency is uniform; these are not reconstructed historical dates. Capture capacity and retention keep their existing defaults.
- `search()` invokes the current screened `createMemoryMcp().tools.amem_search` handler with `limit: 1`. It requires FTS5, checks the selected hit's capture source/project, and returns zero or one `RetrievedMemory`, including source-session attribution and the native score. Empty queries, empty scopes, no matches and explicit configured-policy query denials return `[]`; `top_k: 0` returns `[]`. Larger top_k values still return only the top record, as required by the benchmark's one-experience protocol.
- Content is the existing compact JSON capture hit, with `source`, `evidence`, `capture` and `score`. The native 2,000-character excerpt cap can truncate a long command, output or historical patch. This adapter makes no claim that the prefix preserves a fix span. A representation change belongs to the separately gated #89 work.
- The Bun bridge receives a replacement environment with isolated HOME, amem home, TMP and XDG directories, no API credentials, and isolated Git configuration. It uses the library/MCP handler API; it does not invoke the person CLI or alter its agent-session refusal.

### Synthetic verification and replay

At scratch commit `ff6d3e0`, all 16 synthetic tests passed on dgx02 (Python 3.13.5, Bun 1.4.2):

- Real `run_memory.run_one()` produces `memory.txt` and `memory.json`, feeds only the earlier synthetic history, queries the supplied problem statement, attributes the source session, and excludes synthetic target gold fingerprints.
- The adapter is discoverable through the harness ABC/export contract; add is synchronously searchable; score and compact content come from the native capture hit.
- Both same-instance cross-user isolation and fresh-instance same-user isolation hold. Conflicting scope identity, future/self/wrong-repository sessions and changed-session replay are refused.
- Fresh repeated builds return identical payloads; exact replays do not add rows. Temporary roots are removed after the harness discards an instance.
- The native excerpt cap holds. A configured screening pattern removes a matching synthetic row before top-one selection, allowing the permitted row to be returned.
- Command-argument fallback, paired tool output and legacy exit content work; empty/no-match/top-k cases obey the contract. Mixed-case repositories and the three residual target ID shapes are covered by synthetic sessions. Query denials are explicit and logged; unexpected bridge responses and child failures remain errors.
- Python socket and Bun network API tripwires are enabled during every synthetic add/search and the real `run_one()` check. Deliberate Python connect and Bun fetch probes first prove the tripwires reject access. The Bun preload also rejects inherited credential variable names. This is an API tripwire check, not an OS network sandbox.

Replay from the workspace root, using the configured dgx02 source container:

```bash
python3 _meta/scripts/remote_dev.py src vibemembench-amem-88 -- \
  'git rev-parse HEAD && sha256sum VibeMemBench/scripts/memory_systems/amem.py VibeMemBench/scripts/test_amem_adapter.py && cd VibeMemBench/scripts && ../../.adapter-venv/bin/python -m unittest -v test_amem_adapter'
```

The retained `.adapter-venv` now contains pandas 2.2.3 and pyarrow 18.1.0. Pyarrow 17 has no CPython 3.13 wheel; 18.1.0 is used for the downloaded parquet build, a documented deviation from the pinned harness's stated cap. To recreate it inside that source container, run `uv venv .adapter-venv` and `uv pip install --python .adapter-venv/bin/python pandas==2.2.3 pyarrow==18.1.0`. The test creates its own Bun network-preload wrapper beside the test file. A normal harness invocation instead sets `AMEM_SOURCE=/src/amem-runtime-88` and uses Bun directly; no API key is needed for add/search.

The dataset pilot, solver execution and outcome reporting remain separate. The owner selected an API solver at the paper's settings; the reviewer retains the key and runs the pilot after adapter review. This PR does not run it and leaves #88 open.


### Real-data build correction

The initial build completed 84 targets and failed 27. Twenty-four failures came from comparing repository identity byte-for-byte: `repo_dirname` preserves repository case, while IDs use lowercase (including DevExpress, HypothesisWorks and PyBaMM). The adapter now compares parsed repository prefixes case-insensitively and uses the supplied metadata for the temporal decision.

The three other target IDs are valid and their adds pass. Reproduction against the original adapter identified different search-time failures:

| Target | Existing MCP query-policy refusal |
| --- | --- |
| `aio-libs__aiohttp-8026` | Default email PII detection |
| `dbt-labs__dbt-redshift-420` | 19,873-byte query exceeds the 16KiB per-string policy bound |
| `jhillyerd__enmime-360` | Default email PII detection |

Only diagnostic flags and lengths were recorded; problem text, model credentials and solver output were not logged. The case and identity regressions use synthetic sessions shaped like these repositories and IDs.

The bridge preflights the unchanged, complete query with `configuredPolicy(base, base)`, the same configured standalone policy used by MCP. Only its explicit denial marker becomes an empty result, with a target-ID-only diagnostic in the build log. The adapter neither truncates the query nor weakens row screening. Other bridge, configuration, FTS5 and MCP failures still propagate. The two PII queries and the over-bound query therefore produce empty memory files rather than bypassing the policy. The full rebuild also exposed a default deny-path refusal for `cs-si__eodag-1717` (repository `CS-SI/eodag`), which had previously stopped at the mixed-case identity check.


At `ff6d3e0`, the requested full build was rerun with `--overwrite` into the existing pilot input directory:

```bash
AMEM_SOURCE=/src/amem-runtime-88 ../.adapter-venv/bin/python scripts/run_memory.py --method amem --run-id pilot88 --overwrite
```

Run from `VibeMemBench` in the dgx02 source container, it completed **111 succeeded, 0 skipped, 0 failed**. Auditing every expected target confirmed all 222 `memory.json` / `memory.txt` files belong to `pilot88`, with native capture source/project guards intact: 107 nonempty memories and four explicit policy-denied empty memories (the four target IDs named above). The harness skipped one over-size history session under its unchanged 64 MB limit; no target was skipped. Build success is not a claim that all targets received memory, and this run did not execute a solver or call a model.

The retained build log is `~/code-src/amem-adapter-88-rebuild.log`. The audit manifest, `~/code-src/amem-adapter-88-rebuild-receipt.json`, records relative paths, sizes and SHA-256 hashes for all 222 files, the source/runtime revisions, empty-memory target IDs and skipped-history count; its SHA-256 is `4efd5823922890869aff8bb9889c23ec859df782ea903fa650caa88b9ea0ff91`. The output files remain at `~/code-src/vibemembench-amem-88/VibeMemBench/outputs/memory/amem` for the reviewer's pilot. No API key or agent run was used in this correction.


### Probe 1 variant

[Probe 1 pre-registration](https://github.com/STAIxBWLB/agent-mem/issues/89#issuecomment-6448103705) is implemented as `MEMORY_SYSTEM = AmemCompactMemorySystem`, a subclass of the existing adapter. The remote branch has exactly one new commit above `ff6d3e0`: `8bb042d4f0bc140d0bef7dad8989036fbd4bdab2`. It adds only these two files under `VibeMemBench/scripts/`:

| File | SHA-256 |
| --- | --- |
| `memory_systems/amem_compact.py` | `d9f9bdcd1ea43a38b06843b1550bceffb8f4709938d612daefae93dc25b58ab8` |
| `test_amem_compact.py` | `94911a9455b86d2feb1008dc14061ab6dcb6fcd70949cd9873c6efa5825c06d3` |

`add()` calls the parent unchanged and caches a record from that history alone. `search()` calls the parent once, retains its top-one id, score, timestamp, metadata and source attribution, and replaces only content. No-anchor results return `[]` without falling back to another hit. The original `amem.py`, `run_agent.py` and `run_eval.py` remain unchanged; this task did not write `outputs/`.

The first user message's `<pr_description>` block and exact `Consider the following PR description:` preamble are stripped before taking its first nonempty issue line. These boundaries match public history samples and the pinned mini-swe-agent `bc85a45654e6348dcc6e4c5a40ad146ed0bb144d` configuration `src/minisweagent/config/benchmarks/swebench.yaml`. Only the final exit's `extra.submission` (legacy content fallback) supplies diff headers and hunk contexts.

The record has at most three lines and 600 UTF-8 bytes: the `Earlier fix in ...` line is capped at 160 characters; `Files changed:` contains up to five unique destination paths, joined with `, `; optional `Changed code:` contains up to five unique contexts, each capped at 80 characters and joined with `; `. Byte budgeting preserves complete file paths, drops trailing paths when needed, then shortens the first line further and includes only contexts that fit. If even one complete anchor cannot fit, it returns no record rather than a partial filename. This cap-edge interpretation is exposed here for review before any probe build.

The complete candidate is checked by the same configured policy and shared private-span primitive, through the inherited isolated runner. A disallowed raw-history field therefore cannot re-enter through rendering. Missing anchors and declined compact records have distinct target-ID log markers; other errors propagate. Only the issue line, file headers and hunk contexts are rendered; raw command, tool-output, patch-body and harness-template fields are not copied.

Synthetic verification on dgx02: **31 pass, 0 fail** (all 16 existing tests plus 15 compact tests), with the existing Python/Bun network tripwires enabled. Checks cover exact rendering, caps including multibyte paths, template stripping, no-anchor/no-fallback, identical parent hit and rows, source attribution, excluded raw payload, scope isolation, replay/determinism and record-policy refusals. Replay inside the retained checkout: `cd VibeMemBench/scripts && ../../.adapter-venv/bin/python -m unittest -v test_amem_adapter test_amem_compact`.

No real-data `run_memory.py` build, agent run, model call or API key was used for this variant. The reviewer's build and probe run are reported in Results below.


## Results

Both runs used the API solver at the paper's settings: `openrouter/deepseek/deepseek-v4-pro`, mini-swe-agent at the pinned harness configuration, 4 seeds, one job at a time on dgx02. The pilot and probe were pre-registered before scoring, and the full reports are the issue comments linked below. Differences are in points, with a target-level percentile bootstrap 95% CI (10,000 resamples, seed `0x6d2b79f5`). With n = 19 targets, every result is directional.

### Pilot (#88)

[Pre-registration](https://github.com/STAIxBWLB/agent-mem/issues/88#issuecomment-6439830753), [amendment](https://github.com/STAIxBWLB/agent-mem/issues/88#issuecomment-6446691592), [report](https://github.com/STAIxBWLB/agent-mem/issues/88#issuecomment-6451687811).

The pilot covers 20 targets: 12 Python, 4 JavaScript, and one each in TypeScript, Java, Go and Swift. `dbt-labs__dbt-redshift-420` has policy-empty amem memory, which the harness refuses, so the primary analysis uses the other 19. All 236 runs reached `Submitted`.

| Condition | Resolved (19) | Mean steps | Mean input tokens | Cost |
| --- | --- | --- | --- | --- |
| base (memory off) | 76.3% | 51.6 | 1.75M | $22.13 |
| amem | 75.0% | 42.1 | 1.23M | $14.58 |
| distractor | 77.6% | 43.9 | 1.34M | $19.60 |

- **amem - base:** -1.32 [-13.16, +10.53]. With all 20 targets, counting dbt-redshift-420 as base: -1.25 [-13.75, +8.75].
- **distractor - base:** +1.32 [-9.21, +14.47].
- **amem - distractor:** -2.63 [-18.42, +11.84].
- **Headroom:** amem's losses all fall on targets that base solves 4/4 (marathon-consul-212 4->2, woodwork-640 4->1, cfn-lint-3342 4->3). Its gains fall on 1/4 and 3/4 targets.
- **Steps:** amem cuts steps and input tokens about as much as the distractor does, so fewer steps is not evidence of useful memory.
- **Injected record:** a raw capture hit with a median of 2,387 bytes.

The current injected form does not beat memory-off. There is no full 111-target run, and the pilot became the #89 baseline.

### Probe 1 (#89)

[Pre-registration](https://github.com/STAIxBWLB/agent-mem/issues/89#issuecomment-6448103705), [report](https://github.com/STAIxBWLB/agent-mem/issues/89#issuecomment-6454052107).

`amem_compact` (above) ran on the same 19 targets and seeds, with the same top-1 hit for all 18 targets that got a record. Its records have a median of 290 bytes. `allegro__marathon-consul-212` has no file anchor, so it was not run and is scored as base. All 72 runs completed.

| Condition | Resolved (19 scored) | Cost |
| --- | --- | --- |
| base | 76.32% | $21.88 |
| amem | 75.00% | $14.58 |
| amem_compact | 78.95% | $14.61 |

- **amem_compact - base:** +2.63 [-9.21, +14.47].
- **amem_compact - amem:** +3.95 [-2.63, +10.53]. On the 18 targets that ran, it is +1.39 [-2.78, +5.56]; most of the primary gap is the base-scored marathon-consul-212.
- **woodwork-640:** it still drops 4->1 under the compact record from the same hit. The harm comes from which past fix is surfaced, not from its raw form.

The next-step rule required a CI lower bound for `amem_compact - base` above -2 points, and it was not met. Compact anchored rendering (#89 changes 1 and 3) is recorded as a fail at this n, and there is no amem source change from probe 1. #89 continues with change 4 (timing).

`run_eval.py --skip-existing` rewrites `eval_summary.csv` with only the newly scored rows. The probe analysis therefore read harness verdicts rebuilt from every run's `eval_report.json` (`all_ok and passed_match and not error`, matching `eval.py`'s exit rule). The rebuilt verdicts match the harness's 72-row CSV and every pilot per-target count. The run outputs, rebuilt verdicts and analysis JSON stay in the dgx02 scratch checkout under `VibeMemBench/outputs/`.
