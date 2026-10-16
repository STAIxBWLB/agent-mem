# agent-mem

Curated, shared memory for coding agents, extracted from [agent-hub](https://github.com/STAIxBWLB/agent-hub) (agent-hub#412): append-only JSONL logs per machine, a derived SQLite index that always equals a rebuild, short- and long-term tiers, a typed graph, long-term tasks with leases, and git sync between machines.

Status: extraction in progress (agent-hub#412 P4). The `amem` CLI and the npm package `@staix/agent-mem` are not published yet.

The core imports only Bun and Node built-ins. Privacy policy (what may be stored or shown) is injected by the host through `StoreOptions.screen`.

Data directory: `AMEM_HOME`, else `$AGENTHUB_HOME/memory`, else `~/.agenthub/memory`.

License: MIT.
