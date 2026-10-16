import { MemoryStore } from "@staix/agent-mem-v1";

// Real published legacy reader in a fresh process: never imports current implementation.
const home = process.argv[2];
if (!home) throw new Error("synthetic memory home required");
const store = new MemoryStore({ home, now: () => Date.parse("2030-01-01T00:00:00.000Z") });
try {
  console.log(JSON.stringify(store.list({ project: "agent-hub", limit: 100 }).sort((a, b) => a.id.localeCompare(b.id))));
} finally { store.close(); }
