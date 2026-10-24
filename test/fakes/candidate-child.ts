// A child process for the candidate store concurrency tests: `bun candidate-child.ts open|put <memoryDir> <project> [text]`. Prints one JSON line.
import { CandidateStore } from "../../src/memory/candidates.ts";
const [mode, dir, project, text] = process.argv.slice(2) as [string, string, string, string | undefined];
try {
  const store = new CandidateStore({ memoryDir: dir });
  try {
    if (mode === "put") console.log(JSON.stringify({ ok: true, id: store.put({ project, kind: "memory", text: text ?? "x" }, "public") }));
    else console.log(JSON.stringify({ ok: true }));
  } finally { store.close(); }
} catch (error) { console.log(JSON.stringify({ ok: false, error: (error as Error).message, code: (error as { code?: string }).code ?? null })); }
