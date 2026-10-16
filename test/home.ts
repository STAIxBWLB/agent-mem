import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Preloaded by bunfig.toml: every test run gets its own store home, never the person's ~/.agenthub/memory.
delete process.env.AMEM_HOME;
if (!process.env.AGENTHUB_HOME?.trim()) process.env.AGENTHUB_HOME = mkdtempSync(join(tmpdir(), "amem-test-home-"));
