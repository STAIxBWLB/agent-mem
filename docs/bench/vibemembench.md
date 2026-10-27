# VibeMemBench

## Adapter

This completes the adapter contract in [issue #88](https://github.com/STAIxBWLB/agent-mem/issues/88), step 1. The adapter and its synthetic tests live in a scratch harness checkout on dgx02. No harness code is vendored into amem, and amem's production source is unchanged. This section reports integration checks only; it contains no pilot or solver results.

### Frozen inputs and source

| Input | Revision |
| --- | --- |
| [DAMO-ConvAI harness](https://github.com/AlibabaResearch/DAMO-ConvAI/tree/faf754671f5b850e1b4d1ff870db37a6a2480df6/VibeMemBench) | `faf754671f5b850e1b4d1ff870db37a6a2480df6` |
| Scratch adapter commit, based on that harness | `cb719eab4829e313c405938b8f46dcd5a60f43ae` |
| amem runtime | `6d557ad6c9df158d25e312f9f751b37fc0d2499a` |
| [Public dataset](https://huggingface.co/datasets/Tongyi-ConvAI/VibeMemBench/tree/11164976b4f920cdb0d0cd570ca572e49acea1e8) | `11164976b4f920cdb0d0cd570ca572e49acea1e8` |

The Hugging Face revision API, read on 2026-10-27, reports a public dataset, Apache-2.0, last modified `2026-10-19T08:54:46.000Z`. The earlier blocked-on-data issue comment is stale. These checks did not download the dataset. The adapter contract comes from the pinned `scripts/memory_interface.py`, `scripts/memory_systems/demo.py`, `scripts/CONTRACT.md`, and `scripts/run_memory.py`.

Source delivery is retained on dgx02 under `~/code-src/`, outside this repository:

- Checkout: `vibemembench-amem-88`, branch `amem-adapter-88`, at the scratch commit above.
- Adapter: `VibeMemBench/scripts/memory_systems/amem.py`; SHA-256 `13ef5b06afcaaedbecfc9fa057e93a04b4ba2a96a1e42d4d9be8df13b25e3d40`.
- Synthetic checks: `VibeMemBench/scripts/test_amem_adapter.py`; SHA-256 `9e8b01917271a536503e986605c2efdc6942e3121e349bf8b617e7d96c584ff6`.
- Portable patch against the pinned harness: `amem-adapter-88.patch`; SHA-256 `7dc5654f9a1f559c981e4f59f7cba6d03ca94d5fa4c42a2785ff80b221d06d30`.
- Git bundle: `amem-adapter-88.bundle`; SHA-256 `f56efd378122b19b926a0cfa165f47a2d6e95b32a588a9072fbf40a701e60367`. `git bundle verify` passed.
- Runtime checkout: `amem-runtime-88`, detached at the amem revision above. The adapter refuses a different HEAD or a tracked change under `src/`.
- Check transcript: `amem-adapter-88-checks.log`.

The scratch source and patch are the delivered adapter, not code shipped in the amem package. Keep them for the reviewer's subsequent pilot. The adapter has no Python package dependencies beyond the standard library and the harness interface. The synthetic harness test imports pandas 2.2.3 because `run_memory.py` imports it; it uses no parquet reader, model client, or dataset loader.

### Add and search behavior

- `MEMORY_SYSTEM = AmemMemorySystem` implements the no-argument constructor and synchronous `add(session, *, scope)` / `search(query, *, scope, top_k)` signatures.
- Each instance owns a fresh temporary root. Each exact `MemoryScope.user_id` gets its own amem home and SHA-256-derived project key. Conflicting scope metadata under an existing user_id is refused. A new instance starts empty even for an identical user_id. Explicit close and garbage collection remove its temporary homes.
- `add()` accepts only an earlier history session from the scope's repository, using the issue ordinals supplied by the harness. It pairs assistant commands from `extra.actions` or `tool_calls` with their tool output by `tool_call_id`. It also captures ordinary message text and historical `exit.extra.submission` (falling back to exit content). No trajectory command is executed. No fix-span extraction or synthesis is added.
- Rows use `CaptureStore.append` with deterministic receipts. Identical replay is idempotent; conflicting replay of one session is refused. A spooled append is an error, so success means immediately searchable. The usual secret/private-span handling and capture excerpt ceiling remain in force.
- History has issue ordinals rather than actual PR dates. All rows therefore use the same declared synthetic timestamp, `2000-01-01T00:00:00.000Z`, with a stopped search clock at `2000-01-02T00:00:00.000Z`. Recency is uniform; these are not reconstructed historical dates. Capture capacity and retention keep their existing defaults.
- `search()` invokes the current screened `createMemoryMcp().tools.amem_search` handler with `limit: 1`. It requires FTS5, checks the selected hit's capture source/project, and returns zero or one `RetrievedMemory`, including source-session attribution and the native score. Empty queries, empty scopes and no matches return `[]`; `top_k: 0` returns `[]`. Larger top_k values still return only the top record, as required by the benchmark's one-experience protocol.
- Content is the existing compact JSON capture hit, with `source`, `evidence`, `capture` and `score`. The native 2,000-character excerpt cap can truncate a long command, output or historical patch. This adapter makes no claim that the prefix preserves a fix span. A representation change belongs to the separately gated #89 work.
- The Bun bridge receives a replacement environment with isolated HOME, amem home, TMP and XDG directories, no API credentials, and isolated Git configuration. It uses the library/MCP handler API; it does not invoke the person CLI or alter its agent-session refusal.

### Synthetic verification and replay

At scratch commit `cb719ea`, all 12 synthetic tests passed on dgx02 (Python 3.13.5, Bun 1.4.2):

- Real `run_memory.run_one()` produces `memory.txt` and `memory.json`, feeds only the earlier synthetic history, queries the supplied problem statement, attributes the source session, and excludes synthetic target gold fingerprints.
- The adapter is discoverable through the harness ABC/export contract; add is synchronously searchable; score and compact content come from the native capture hit.
- Both same-instance cross-user isolation and fresh-instance same-user isolation hold. Conflicting scope identity, future/self/wrong-repository sessions and changed-session replay are refused.
- Fresh repeated builds return identical payloads; exact replays do not add rows. Temporary roots are removed after the harness discards an instance.
- The native excerpt cap holds. A configured screening pattern removes a matching synthetic row before top-one selection, allowing the permitted row to be returned.
- Command-argument fallback, paired tool output and legacy exit content work; empty/no-match/top-k cases obey the contract.
- Python socket and Bun network API tripwires are enabled during every synthetic add/search and the real `run_one()` check. Deliberate Python connect and Bun fetch probes first prove the tripwires reject access. The Bun preload also rejects inherited credential variable names. This is an API tripwire check, not an OS network sandbox.

Replay from the workspace root, using the configured dgx02 source container:

```bash
python3 _meta/scripts/remote_dev.py src vibemembench-amem-88 -- \
  'git rev-parse HEAD && sha256sum VibeMemBench/scripts/memory_systems/amem.py VibeMemBench/scripts/test_amem_adapter.py && cd VibeMemBench/scripts && ../../.adapter-venv/bin/python -m unittest -v test_amem_adapter'
```

The retained `.adapter-venv` contains the test-only pandas dependency. To recreate it inside that source container, run `uv venv .adapter-venv` and `uv pip install --python .adapter-venv/bin/python pandas==2.2.3`. The test creates its own Bun network-preload wrapper beside the test file. A normal harness invocation instead sets `AMEM_SOURCE=/src/amem-runtime-88` and uses Bun directly; no API key is needed for add/search.

The dataset pilot, solver execution and outcome reporting remain separate. The owner selected an API solver at the paper's settings; the reviewer retains the key and runs the pilot after adapter review. This PR does not run it and leaves #88 open.
