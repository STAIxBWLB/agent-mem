# Failure-hook host support

Survey completed 2026-10-29 KST for #139 and #89 change 4. This is native capability research, not an implementation or an adoption decision. No native client or solver/benchmark was run, and no live configuration was accessed. The shipped amem hooks still follow [the current capture/context boundary](contracts.md#p3-hook-and-native-intake-boundaries-13).

**Context support is event-specific.** A notification, a hook output type, and a model-facing result transformation are different contracts. The table distinguishes documented support from source-traced delivery. Neither establishes behavior in a person's installed client. Unknowns remain explicit.

## Capability matrix

Each factual cell links to official docs or commit-pinned source. Full pins and interpretation limits follow the table. Timeouts are native handler limits, not amem's R2 budget.

| Client and checked version | Failure or post-tool event | Can hook output add model-visible context? | Signals for test/build failure selection | Native hook timeout |
| --- | --- | --- | --- | --- |
| Claude Code: SDK bundle metadata names **2.1.312**; native execution unknown. [Metadata][C-pin] | `PostToolUseFailure`. [Input type][C-input] | **Documented yes:** `hookSpecificOutput.additionalContext` accompanies the error. [Contract][C-context] | `tool_name`, `tool_input` (Bash `command`), `error`, optional `is_interrupt`. Error text is tool-dependent; no test/build category. [Fields][C-input] [Bash example][C-context] | Synchronous command hook default **600 seconds**, configurable `timeout`, in the unversioned docs snapshot. Binding to an installed CLI version is unknown. [Timeout][C-timeout] |
| Codex **0.165.0**, `360319d8`. [Release][X-pin] | `PostToolUse`; no separate failure event in this pin. [Runtime events][X-runtime-events] [Wire events][X-events] | **Source-traced yes:** exit-0 hook JSON context becomes a developer conversation item. [Parser][X-parser] [Consumer][X-consumer] [Role][X-role] | `tool_name`, `tool_input.command`, `tool_response`. Unified exec nonzero exits still trigger the hook, but its response is truncated process output with no structured exit status or generated exit-code header. Generic tool errors can skip it. [Hook response][X-hook-response] [Model header][X-model-header] [Dispatch][X-dispatch] | Default **600 seconds**, minimum 1 second; runner uses seconds. [Default][X-timeout] [Runner][X-runner] |
| Kimi Code **2.3.3**, `ec495f0c`. [Release][K-pin] | `PostToolUseFailure` / successful `PostToolUse`. [Producer][K-producer] | **No on these observer events:** fire-and-forget dispatch discards hook results. Other event contracts do not imply failure-event injection. [Dispatch][K-dispatch] | `tool_name`, `tool_input`, `tool_call_id`, `error`. Failure selection uses `result.isError`; the error payload has no dedicated test/build or process-exit field. [Producer][K-producer] [Error shape][K-error] | Default **30 seconds**; integer `timeout` range 1-600 seconds. [Configuration][K-doc] |
| Pi **1.4.0**, `4a080252`. [Release][P-pin] | `tool_result` transformer; `tool_execution_end` is a notification. [Event roles][P-events] | **Source-traced yes through `tool_result`:** returned content changes the tool-result message. Notification return values do not do this. [Transform][P-consumer] [Message][P-message] [Context][P-context] | Transformer exposes `input`, `isError`, content and structured result. Built-in Bash has `input.command` and structured `exit_code`; nonzero sets the error flag. No test/build category. [Bash][P-bash] [Failure flag][P-bash-result] | Callback deadline **unknown/not documented**; handlers are awaited. Bash's separate tool timeout must not be treated as a hook timeout. [Handler contract][P-handler] |
| Qwen Code **0.26.1**, `1ce17311`. [Package][Q-pin] | `PostToolUseFailure` / `PostToolUse`. [Fields][Q-input] | **Source-traced yes:** hook context is appended to the error and included in the completed tool response. [Failure handling][Q-consumer] [Response assembly][Q-response] | `tool_name`, `tool_input`, `error`, optional `is_interrupt`. No test/build discriminator or structured exit code in this failure input. [Fields][Q-input] [Producer][Q-producer] | Command default **60 seconds**. Values below 1000 mean seconds; values at least 1000 retain legacy milliseconds. [Default][Q-default] [Conversion][Q-timeout] |
| Jcode **0.99.1**, `7206efd0`. [Package][J-pin] | `post_tool` observer; `post_tool_feedback` after an `Ok` result. [Dispatch][J-events] | **Conditional:** observer stdout is discarded; feedback stdout is appended to a successful tool result before the next provider request. It does not run on the tool `Err` path. [Feedback][J-feedback] [Model path][J-consumer] | Tool input plus `status`, `output_bytes` / error metadata. Nonzero Bash exit can still be `Ok`/`status=ok`; feedback gets neither result text nor a dedicated exit code. [Event fields][J-events] [Bash][J-bash] | Observer has **no timer in the inspected runner**; no bounded deadline established. Feedback default **10,000 ms**, configurable in milliseconds. [Observer][J-observer] [Feedback limit][J-limit] |
| Antigravity: **native version unknown**, official docs snapshot 2026-10-28. [Docs][A-doc] | `PostToolUse`, including an optional failure `error`. [Event][A-post] | **Documented no direct output at this event:** its response is `{}`. Separate `PreInvocation.injectSteps` support is not failure-event delivery. Actual native implementation/version unknown. [Post-tool][A-post] [Other event][A-pre] | `toolCall.name`, `toolCall.args` (example `CommandLine`), optional `error`, `stepIdx`. No documented test/build category or structured process exit field. [Payload][A-post] | Documented default **30 seconds**, integer `timeout`; native version binding unknown. [Configuration][A-timeout] |

## Reading the evidence

- **Claude Code:** the pinned SDK freezes the [input][C-input]/[output][C-output] types and the bundled CLI version metadata. It does not expose the native CLI implementation or bind the mutable docs to that binary. The context and timeout claims above are **documented**, not runtime-tested. A stable structured test/build classification is unknown.
- **Codex:** the dispatch conclusion combines the registry's success gate with unified exec's successful-tool classification, even for a nonzero command exit. That is source reasoning, not a native failed-test smoke. The generated exit-code header belongs to the model response, not the hook input; output-only failure selection is therefore not guaranteed. Input keys are snake_case; output keys such as `hookSpecificOutput.additionalContext` are camelCase. [Dispatch][X-dispatch] [Input][X-input] [Hook output][X-output] [Wrapper][X-wrapper]
- **Kimi:** the general statement that stdout may add context is narrowed by the event-specific observer dispatch. A failure's normal tool result is distinct from context returned by its hook. [Observer contract][K-observer] [Dispatch][K-dispatch]
- **Pi:** these are in-process extension callbacks, not command hooks. Use of the result transformer is a capability finding, not a proposed amem extension. The inspected version has no documented callback timeout guarantee. [Extension contract][P-doc]
- **Qwen:** ordinary errors and timeouts have separate context assembly paths. Direct error append is conditional on parent routing; delivery through a parent is unknown here. Success hooks append context separately. None of that supplies a semantic test/build label. [Ordinary failure][Q-response] [Timeout][Q-timeout-response] [Success][Q-success]
- **Jcode:** a command's exit status and a tool's `Result` are not interchangeable. Bash can return normal output containing a nonzero exit, so a feedback hook can run while lacking the data needed to gate on that failure. The detached observer has null stdio and a reaper, not an enforced execution deadline in the inspected path. [Shell result][J-bash] [Observer runner][J-observer]
- **Antigravity:** the official page covers App, CLI and IDE but supplies no build/version mapping. A future two-event design involving `PreInvocation` would need separate verification; it is not established by the `PostToolUse` contract. [Docs][A-doc]

Command text can suggest a test or build invocation; that is an inference, not a universal native classification field. Missing tool paths, parse/validation failures and background command completion need their own host-specific proof before any implementation. Host capability alone does not satisfy #89's outcome, privacy or resource gates.

## Source pins and unknowns

- Claude Agent SDK source: `2d485201617258867dd0f74b9e7307056f5938fe`; its `_cli_version.py` names `2.1.312`. Native execution and version binding of the official docs remain unknown.
- Codex `rust-v0.165.0`: tag object `e374836b2728d9b7aa981c2902649e640a2edaa8`, peeled commit `360319d8dee62d87e2d59fc0c21805d79519cfed`.
- Kimi Code `@moonshot-ai/kimi-code@2.3.3`: commit `ec495f0cb00f6db9a9118bf979112886f4264a41`.
- Pi `v1.4.0`: commit `4a080252f06caf63a525d7873c5d94d3c23887e0`. The former [`badlogic/pi-mono`](https://github.com/badlogic/pi-mono) repository redirects to `earendil-works/pi`.
- Qwen Code package `0.26.1`: commit `1ce173117196ab9a9f77b5d19ac148cbabe25dfd`.
- Jcode `v0.99.1`: tag object `479ff29de307861747f5e697028cde3505f265ec`, peeled commit `7206efd0c1dbf49ef38d06b63f3a96a3a7cee611`.
- Versionless official docs were fetched on 2026-10-28 UTC. HTTP response-body SHA-256 receipts, not native release identifiers: Claude `https://code.claude.com/docs/en/hooks.md`, `ffc7195446eb6048fb54e8351b31c00e0280d303c339f4829023a9215d4ecc76`; Antigravity `https://antigravity.google/docs/hooks`, `cec4eeee879c570571a4847fca590a265d7e28810b2f8bc66fde09bc328337f9`. Later page changes do not update this finding automatically. No claim is made about a different release or the person's installed binaries.

[C-pin]: https://github.com/anthropics/claude-agent-sdk-python/blob/2d485201617258867dd0f74b9e7307056f5938fe/src/claude_agent_sdk/_cli_version.py#L3
[C-input]: https://github.com/anthropics/claude-agent-sdk-python/blob/2d485201617258867dd0f74b9e7307056f5938fe/src/claude_agent_sdk/types.py#L370-L381
[C-context]: https://code.claude.com/docs/en/hooks#posttoolusefailure
[C-timeout]: https://code.claude.com/docs/en/hooks#common-fields
[X-pin]: https://github.com/openai/codex/releases/tag/rust-v0.165.0
[X-events]: https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/hooks/src/schema.rs#L102-L126
[X-input]: https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/hooks/src/schema.rs#L321-L343
[X-parser]: https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/hooks/src/events/post_tool_use.rs#L169-L209
[X-consumer]: https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/core/src/hook_runtime.rs#L868-L894
[X-dispatch]: https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/core/src/tools/registry.rs#L885-L930
[X-timeout]: https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/hooks/src/engine/discovery.rs#L946-L970
[X-runner]: https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/hooks/src/engine/command_runner.rs#L224-L233
[K-pin]: https://github.com/MoonshotAI/kimi-code/releases/tag/%40moonshot-ai/kimi-code%402.3.3
[K-producer]: https://github.com/MoonshotAI/kimi-code/blob/ec495f0cb00f6db9a9118bf979112886f4264a41/packages/agent-core-v2/src/features/externalHooks/agent/agentExternalHooksService.ts#L320-L334
[K-dispatch]: https://github.com/MoonshotAI/kimi-code/blob/ec495f0cb00f6db9a9118bf979112886f4264a41/packages/agent-core-v2/src/features/externalHooks/agent/agentExternalHooksService.ts#L118-L139
[K-error]: https://github.com/MoonshotAI/kimi-code/blob/ec495f0cb00f6db9a9118bf979112886f4264a41/packages/agent-core-v2/src/_base/errors/serialize.ts#L5-L14
[K-doc]: https://github.com/MoonshotAI/kimi-code/blob/ec495f0cb00f6db9a9118bf979112886f4264a41/docs/en/customization/hooks.md#L42-L49
[P-pin]: https://github.com/earendil-works/pi/releases/tag/v1.4.0
[P-doc]: https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/extensions.md#L147-L224
[P-consumer]: https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/agent-session.ts#L687-L723
[P-message]: https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/agent/src/agent-loop.ts#L940-L959
[P-bash]: https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/tools/bash.ts#L40-L62
[Q-pin]: https://github.com/QwenLM/qwen-code/blob/1ce173117196ab9a9f77b5d19ac148cbabe25dfd/package.json#L4
[Q-input]: https://github.com/QwenLM/qwen-code/blob/1ce173117196ab9a9f77b5d19ac148cbabe25dfd/packages/core/src/hooks/types.ts#L833-L872
[Q-producer]: https://github.com/QwenLM/qwen-code/blob/1ce173117196ab9a9f77b5d19ac148cbabe25dfd/packages/core/src/core/toolHookTriggers.ts#L363-L399
[Q-consumer]: https://github.com/QwenLM/qwen-code/blob/1ce173117196ab9a9f77b5d19ac148cbabe25dfd/packages/core/src/core/coreToolScheduler.ts#L7177-L7224
[Q-response]: https://github.com/QwenLM/qwen-code/blob/1ce173117196ab9a9f77b5d19ac148cbabe25dfd/packages/core/src/core/coreToolScheduler.ts#L7415-L7430
[Q-timeout-response]: https://github.com/QwenLM/qwen-code/blob/1ce173117196ab9a9f77b5d19ac148cbabe25dfd/packages/core/src/core/coreToolScheduler.ts#L7305-L7312
[Q-success]: https://github.com/QwenLM/qwen-code/blob/1ce173117196ab9a9f77b5d19ac148cbabe25dfd/packages/core/src/core/coreToolScheduler.ts#L6921-L6927
[Q-timeout]: https://github.com/QwenLM/qwen-code/blob/1ce173117196ab9a9f77b5d19ac148cbabe25dfd/packages/core/src/hooks/hook-timeout.ts#L175-L213
[J-pin]: https://github.com/1jehuang/jcode/blob/7206efd0c1dbf49ef38d06b63f3a96a3a7cee611/Cargo.toml#L1-L3
[J-events]: https://github.com/1jehuang/jcode/blob/7206efd0c1dbf49ef38d06b63f3a96a3a7cee611/crates/jcode-app-core/src/tool/mod.rs#L828-L924
[J-feedback]: https://github.com/1jehuang/jcode/blob/7206efd0c1dbf49ef38d06b63f3a96a3a7cee611/crates/jcode-app-core/src/tool/mod.rs#L894-L924
[J-consumer]: https://github.com/1jehuang/jcode/blob/7206efd0c1dbf49ef38d06b63f3a96a3a7cee611/crates/jcode-app-core/src/agent/turn_loops.rs#L1284-L1321
[J-bash]: https://github.com/1jehuang/jcode/blob/7206efd0c1dbf49ef38d06b63f3a96a3a7cee611/crates/jcode-app-core/src/tool/bash.rs#L1155-L1167
[J-observer]: https://github.com/1jehuang/jcode/blob/7206efd0c1dbf49ef38d06b63f3a96a3a7cee611/crates/jcode-base/src/hooks.rs#L342-L376
[J-limit]: https://github.com/1jehuang/jcode/blob/7206efd0c1dbf49ef38d06b63f3a96a3a7cee611/crates/jcode-config-types/src/lib.rs#L950-L976
[A-doc]: https://antigravity.google/docs/hooks
[A-post]: https://antigravity.google/docs/hooks#posttooluse
[A-pre]: https://antigravity.google/docs/hooks#preinvocation
[A-timeout]: https://antigravity.google/docs/hooks#hook-handler-configuration
[K-observer]: https://github.com/MoonshotAI/kimi-code/blob/ec495f0cb00f6db9a9118bf979112886f4264a41/docs/en/customization/hooks.md#L102-L116
[P-events]: https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/extensions.md#L101-L120
[P-handler]: https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/extensions/runner.ts#L1092-L1122
[P-bash-result]: https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/tools/bash.ts#L390-L408
[Q-default]: https://github.com/QwenLM/qwen-code/blob/1ce173117196ab9a9f77b5d19ac148cbabe25dfd/packages/core/src/hooks/hook-timeout.ts#L16-L37
[C-output]: https://github.com/anthropics/claude-agent-sdk-python/blob/2d485201617258867dd0f74b9e7307056f5938fe/src/claude_agent_sdk/types.py#L539-L543
[X-role]: https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/core/src/context/hook_additional_context.rs#L19-L42
[P-context]: https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/agent/src/agent-loop.ts#L267-L286
[X-hook-response]: https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/core/src/tools/context.rs#L482-L565
[X-model-header]: https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/core/src/tools/context.rs#L594-L618
[X-output]: https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/hooks/src/schema.rs#L229-L240
[X-wrapper]: https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/hooks/src/schema.rs#L143-L156
[X-runtime-events]: https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/protocol/src/hooks.rs#L8-L45
