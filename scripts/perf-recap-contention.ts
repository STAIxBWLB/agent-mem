import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { MemoryStore } from "../src/memory/store.ts";
import { migrate } from "../src/memory/migrate.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { appendMetrics } from "../src/memory/metrics.ts";
import { withBriefSnapshot, RecapSourceChangedError } from "../src/memory/doctor.ts";
import { sessionStartBrief } from "../src/session-brief.ts";
import * as curatedModule from "../src/memory/curated-read.ts";
import { plugin } from "../src/ui/plugin.ts";

// Run with `RECAP_PROBE_ROWS=2000 bun test ./scripts/perf-recap-contention.ts` on a disposable synthetic home.
// For the pre-fix revision, set RECAP_EXPECT_FAILURE=1. These timings are not live-home AC3 evidence.
test("isolated recap capture and metrics probe", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "amem-recap-probe-"));
  const base = join(root, "memory"), project = "fixture/recap";
  const noteCount = Number(process.env.RECAP_PROBE_ROWS ?? "250");
  const prior = process.env.AMEM_HOME;
  process.env.AMEM_HOME = base;
  let worker: ReturnType<typeof Bun.spawn> | undefined;
  let copies: ReturnType<typeof spyOn> | undefined, opens: ReturnType<typeof spyOn> | undefined;
  try {
    const store = new MemoryStore({ memoryDir: base, deferPromotions: true });
    try { for (let i = 0; i < noteCount; i++) store.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "fixture", source: "person", text: `격리된 진단 메모 ${i} with bounded synthetic content`, about: [] }); } finally { store.close(); }
    if (process.env.RECAP_PROBE_GENERATION === "1") await migrate({ memoryDir: base, generation: "e".repeat(32), mode: "apply", authorizedPerson: true, tty: true });
    const capture = new CaptureStore({ memoryDir: base, project, cwd: root });
    try { capture.append({ project, agent: "fixture", event: "Stop", excerpt: "격리된 테스트" }); } finally { capture.close(); }
    appendMetrics(base, [{ at: new Date().toISOString(), kind: "hook", wallMs: 1 }]);
    let stableCopyMs = 0, stableCopyBytes = 0, stableOpenMs = 0, stableReadMs = 0, stableVerifyMs = 0;
    const stableCopy = fs.copyFileSync, stableOpen = curatedModule.openCuratedForRead;
    copies = spyOn(fs, "copyFileSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike, flags?: number) => {
      const size = fs.statSync(from).size, started = performance.now();
      try { return stableCopy(from, to, flags); } finally { stableCopyMs += performance.now() - started; stableCopyBytes += size; }
    }) as typeof fs.copyFileSync);
    let baselineOpen = 0;
    opens = spyOn(curatedModule, "openCuratedForRead").mockImplementation(((...args: Parameters<typeof stableOpen>) => { const t = performance.now(); try { return stableOpen(args[0], args[1]); } finally { baselineOpen += performance.now() - t; } }) as typeof stableOpen);
    const baselineStart = performance.now();
    const baseline = await withBriefSnapshot(base, project, async measureOnly => sessionStartBrief({ cwd: root, base, project, repository: false, measureOnly }));
    const baselineTotal = performance.now() - baselineStart;
    opens.mockRestore(); opens = undefined;
    stableCopyMs = 0; stableCopyBytes = 0;
    opens = spyOn(curatedModule, "openCuratedForRead").mockImplementation(((...args: Parameters<typeof stableOpen>) => { const t = performance.now(); try { return stableOpen(...args); } finally { stableOpenMs += performance.now() - t; } }) as typeof stableOpen);
    const stableBegin = performance.now();
    const current = await withBriefSnapshot(base, project, async measureOnly => {
      const started = performance.now(); try { return await sessionStartBrief({ cwd: root, base, project, repository: false, measureOnly }); }
      finally { stableReadMs += performance.now() - started; }
    }, validate => { const started = performance.now(); validate(); stableVerifyMs += performance.now() - started; });
    const stableTotalMs = performance.now() - stableBegin;
    expect(current).toEqual(baseline);
    console.log(JSON.stringify({ fixture: "synthetic", layout: process.env.RECAP_PROBE_GENERATION === "1" ? "generation" : "shared-v1", case: "paired-open", notes: noteCount, baselineOpenMs: baselineOpen, baselineTotalMs: baselineTotal, scratchOpenMs: stableOpenMs, scratchTotalMs: stableTotalMs, outputsEqual: true }));
    copies.mockRestore(); copies = undefined; opens.mockRestore(); opens = undefined;
    console.log(JSON.stringify({ fixture: "synthetic", case: "uncached-stable-projection", notes: noteCount, copyBytes: stableCopyBytes, copyMs: stableCopyMs,
      openMs: stableOpenMs, readMs: stableReadMs, extraValidationMs: stableVerifyMs, totalMs: stableTotalMs,
      note: "extra validation is a separate pass; total includes it plus setup, internal checks and cleanup" }));
    const provider = await plugin.open({ home: root, log: () => {} });
    try {
      const first = await provider.snapshot({ panel: "recap", project, after: 0 });
      expect(first.error).toBeUndefined(); expect(Number.isSafeInteger(first.cursor)).toBe(true);
      appendMetrics(base, [{ at: new Date().toISOString(), kind: "hook", wallMs: 1 }]);
      const warmBegin = performance.now(), warm = await provider.snapshot({ panel: "recap", project, after: Number(first.cursor) });
      const warmMs = performance.now() - warmBegin;
      console.log(JSON.stringify({ fixture: "synthetic", case: "warm-after-telemetry-only", notes: noteCount, warmMs, changed: warm.changed ?? true,
        note: "no capture DB write occurred between these snapshots" }));
      if (process.env.RECAP_EXPECT_FAILURE === "1") expect(warm.changed).not.toBe(false);
      else expect(warm.changed).toBe(false);
    } finally { await provider.close(); }
    const captureUrl = pathToFileURL(join(import.meta.dir, "../src/memory/capture.ts")).href;
    const metricsUrl = pathToFileURL(join(import.meta.dir, "../src/memory/metrics.ts")).href;
    const progress = join(root, "writer-progress.json");
    const child = `const {CaptureStore}=await import(${JSON.stringify(captureUrl)});const {appendMetrics}=await import(${JSON.stringify(metricsUrl)});const {writeFileSync,renameSync}=await import('node:fs');const base=${JSON.stringify(base)}, project=${JSON.stringify(project)}, cwd=${JSON.stringify(root)}, progress=${JSON.stringify(progress)};const c=new CaptureStore({memoryDir:base,project,cwd});process.stdout.write('ready');const first=Date.now();try{for(let i=0;i<1000;i++){c.append({project,agent:'fixture',event:'Stop',excerpt:'synthetic capture'});appendMetrics(base,[{at:new Date().toISOString(),kind:'hook',wallMs:1}]);writeFileSync(progress+'.tmp',JSON.stringify({first,last:Date.now(),count:i+1}));renameSync(progress+'.tmp',progress);await Bun.sleep(10);}}finally{c.close();}`;
    worker = Bun.spawn([process.execPath, "-e", child], { cwd: root, env: { ...process.env, HOME: root, AMEM_HOME: base }, stdout: "pipe", stderr: "pipe" });
    const stdout = worker.stdout;
    if (!(stdout instanceof ReadableStream)) throw Error("synthetic capture writer has no stdout pipe");
    const ready = await stdout.getReader().read();
    expect(new TextDecoder().decode(ready.value)).toContain("ready");
    let copyMs = 0, copyBytes = 0, openMs = 0, readMs = 0, verifyMs = 0, metricsCopies = 0;
    const metricsSizes: number[] = [];
    const copyOriginal = fs.copyFileSync, openOriginal = curatedModule.openCuratedForRead;
    copies = spyOn(fs, "copyFileSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike, flags?: number) => {
      const started = performance.now(), bytes = fs.statSync(from).size;
      const result = copyOriginal(from, to, flags); copyMs += performance.now() - started; copyBytes += bytes;
      if (String(from) === join(base, "metrics.jsonl")) {
        metricsCopies++; metricsSizes.push(bytes);
      }
      return result;
    }) as typeof fs.copyFileSync);
    opens = spyOn(curatedModule, "openCuratedForRead").mockImplementation(((...args: Parameters<typeof openOriginal>) => {
      const started = performance.now(); try { return openOriginal(...args); } finally { openMs += performance.now() - started; }
    }) as typeof openOriginal);
    const begin = performance.now(), startedAt = Date.now(); let errorClass = "none";
    try {
      await withBriefSnapshot(base, project, async measureOnly => {
        const started = performance.now(); try { return await sessionStartBrief({ cwd: root, base, project, repository: false, measureOnly }); }
        finally { readMs += performance.now() - started; }
      }, validate => { const started = performance.now(); validate(); verifyMs += performance.now() - started; });
    } catch (error) { errorClass = error instanceof RecapSourceChangedError ? error.name : "other"; }
    const totalMs = performance.now() - begin;
    const writer = JSON.parse(fs.readFileSync(progress, "utf8")) as { first: number; last: number; count: number };
    metricsSizes.push(fs.statSync(join(base, "metrics.jsonl")).size);
    if (process.env.RECAP_EXPECT_FAILURE === "1") { expect(errorClass).toBe("RecapSourceChangedError"); expect(metricsCopies).toBe(3); expect(new Set(metricsSizes).size).toBeGreaterThan(1); }
    else { expect(errorClass).toBe("none"); expect(metricsCopies).toBe(0); }
    expect(writer.count).toBeGreaterThan(0); expect(writer.last).toBeGreaterThanOrEqual(startedAt);
    console.log(JSON.stringify({ fixture: "synthetic", concurrentCapture: true, writerCount: writer.count, sourceClass: "top-level metrics.jsonl", errorClass, metricsCopies, copyBytes, copyMs, openMs, readMs, verifyMs, totalMs, note: "verification callback does not run on failed attempts; unmeasured time includes checks and scratch cleanup" }));
  } finally {
    copies?.mockRestore(); opens?.mockRestore();
    if (worker) await worker.exited;
    if (prior === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
