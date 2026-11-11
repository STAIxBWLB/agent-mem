import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const PHASE_SLOT_BYTES = 512, PHASE_SLOTS = 64, MAX_PHASE_MARKS = 4096, MAX_PHASE_PROCESSES = 8;
export const transcriptPhases = ["unused", "preload", "bin-entry", "import-start", "import-end", "handler-start", "handler-end", "worker-spawn-start", "worker-spawn-end", "worker-entry", "scan-start", "scan-end", "cursor-open-start", "cursor-open-end", "cursor-commit-start", "cursor-commit-end", "cursor-close-start", "cursor-close-end", "capture-open-start", "capture-open-end", "replay-start", "replay-end", "capture-drain-start", "capture-drain-end", "capture-tx-start", "capture-tx-end", "capture-close-start", "capture-close-end", "metadata-start", "metadata-end", "stop-start", "live-rss-start", "live-rss-end", "kill-start", "kill-end", "reap-start", "reap-end", "output-wait-start", "output-wait-end", "abandoned", "accounting-rss-start", "accounting-rss-end", "variant-start", "variant-end", "self-rss-start", "self-rss-end", "metric-sample", "metric-write-start", "metric-write-end", "exit", "observer-cost", "module-loaded", "truncated", "cursor-tx-start", "cursor-tx-end", "first-drain-start", "first-drain-frame-end"] as const;
const mark = (id: number, value = "0") => `globalThis.__amemTranscriptPhase(${id},${value});`;
export interface PhaseAnchor { name: string; anchor: string; at: "before" | "after" | "first-brace" | "last-brace"; code: string }
const before = (name: string, anchor: string, code: string): PhaseAnchor => ({ name, anchor, at: "before", code });
const after = (name: string, anchor: string, code: string): PhaseAnchor => ({ name, anchor, at: "after", code });
const wrap = (name: string, start: string, end: string, enter: number, leave: number, last = false): PhaseAnchor[] => [
  after(name + "-start", start, mark(enter) + "try {"),
  { name: name + "-end", anchor: end, at: last ? "last-brace" : "first-brace", code: `}finally{${mark(leave)}}` },
];
const reap = "      const reaped = exited || !(await boundedWait(exit!)).late;";
const output = "      const body = reaped ? await boundedWait(output!) : { late: true };";
const variant = '    try { appendRecordVariant(canonicalPath(memoryHome()), args[0] ?? "", { at: new Date().toISOString(), kind: "hook", ...recordMetric, ...emittedCost }); } catch { /* Observations never change tool outcomes. */ }';
export const transcriptPhaseAnchors: Record<string, readonly PhaseAnchor[]> = {
  "bin/amem.js": [
    before("bin-entry", "const args = process.argv.slice(2);", mark(2)),
    before("import-start", '    const { hookMain } = await import("../src/hooks.ts");', mark(3)),
    after("import-end", '    const { hookMain } = await import("../src/hooks.ts");', mark(4)),
    before("handler-start", "    const output = await hookMain(args.slice(1), started);", mark(5, "performance.timeOrigin+started")),
    after("handler-end", "    const output = await hookMain(args.slice(1), started);", mark(6)),
  ],
  "src/hooks.ts": [
    before("metadata-start", "    metadata = await parentProject(options, base, workDeadline);", mark(28)),
    after("metadata-end", "    metadata = await parentProject(options, base, workDeadline);", mark(29)),
    after("stop-start", "    if (!owned || exited) return;", mark(30, "owned.pid")),
    before("live-rss-start", "    tracker!.captureLive();", mark(31)),
    after("live-rss-end", "    tracker!.captureLive();", mark(32)),
    before("reap-start", reap, mark(35)), after("reap-end", reap, mark(36, "Number(reaped)")),
    before("output-start", output, mark(37)), after("output-end", output, mark(38, "Number(body.late)")),
    after("abandoned", "      if (!reaped) abandonedChildren++;", mark(39, "Number(!reaped)")),
    before("accounting-start", "      const accounting = tracker!.finish(workerRawKB);", mark(40)),
    after("accounting-end", "      const accounting = tracker!.finish(workerRawKB);", mark(41)),
    before("variant-start", variant, mark(42)), after("variant-end", variant, mark(43)),
    before("self-rss-start", "      const self = hookRssReading();", mark(44)),
    after("self-rss-end", "      const self = hookRssReading();", mark(45)),
    before("metric-sample", "      appendMetrics(canonicalPath(memoryHome()), [{", mark(46)),
  ],
  "src/session-brief-worker.ts": [
    after("worker-entry", "if (import.meta.main) {", mark(9)),
    before("first-drain-start", "        drain({ startMs: Math.round(now() - (options.hookStartAt ?? end)), drained: drainedCount });", mark(55, "options.hookStartAt ?? end")),
    after("first-drain-frame-end", "        drain({ startMs: Math.round(now() - (options.hookStartAt ?? end)), drained: drainedCount });", mark(56)),
    ...wrap("replay", "    const replay = async (until: number, waitForReady = true) => {", "\n    };\n    let context: Awaited<typeof ready>;", 20, 21),
  ],
  "src/hook-transcript.ts": [
    ...wrap("cursor-open", "export function cursorDatabase(file: string, dev: string, ino: string, size: number): Database {", "\n}\n\n/** Private per-session transaction", 12, 13),
    after("cursor-db-watch", "  const db = new Database(file);", "globalThis.__amemWatchPhaseDb(db,53,54);"),
    before("cursor-initial-commit", '      db.run("COMMIT"); db.run("BEGIN IMMEDIATE");', mark(14)),
    after("cursor-initial-commit-end", '      db.run("COMMIT");', mark(15)),
    before("cursor-final-commit", '\n    db.run("COMMIT");', mark(14)),
    after("cursor-final-commit-end", '\n    db.run("COMMIT");', mark(15)),
    before("cursor-close-start", 'db.close(); } } finally { closeSync(fd); }', mark(16)),
    after("cursor-close-end", 'db.close(); } } finally { closeSync(fd); }', mark(17)),
    ...wrap("scan", "export async function scanHookTranscriptTail(input: unknown, options: Options): Promise<HookTranscriptProgress | undefined> {", '\n    try { if (db) { try { db.run("ROLLBACK"); } catch { /* Already committed. */ } db.close(); } } finally { closeSync(fd); }\n  }\n}\n', 10, 11, true),
  ],
  "src/memory/capture.ts": [
    after("capture-open-start", "  constructor(opts: CaptureOptions) {", mark(18) + "try {"),
    { name: "capture-open-end", anchor: "\n  }\n\n  private existingMachine(): string", at: "first-brace", code: `}finally{if(this.db)globalThis.__amemWatchPhaseDb(this.db,24,25);${mark(19)}}` },
    ...wrap("capture-drain", "  drain(): { drained: number; skipped: number } {", "\n  }\n\n  /** The row insert shared", 22, 23),
    before("capture-close-start", "this.db.close(); }\n}", mark(26)),
    after("capture-close-end", "this.db.close();", mark(27)),
  ],
  "src/memory/metrics.ts": [
    ...wrap("metric-write", "export function appendMetrics(base: string, samples: MetricSample[]): void {", "\n}\n\n/** The newest samples first-preserved", 47, 48),
  ],
};

/** Exact source witnesses are checked before any subprocess, including dormant paths. */
export function instrumentTranscriptSource(file: string, source: string): string {
  const anchors = transcriptPhaseAnchors[file];
  if (!anchors) throw Error(`unknown transcript phase source: ${file}`);
  const insertions = anchors.map((a, order) => {
    if (source.split(a.anchor).length !== 2) throw Error(`transcript phase anchor ${a.name} in ${file} must match exactly once`);
    const start = source.indexOf(a.anchor);
    const offset = a.at === "before" ? 0 : a.at === "after" ? a.anchor.length : a.at === "first-brace" ? a.anchor.indexOf("}") : a.anchor.lastIndexOf("}");
    if (offset < 0) throw Error(`transcript phase brace anchor ${a.name} in ${file} is unavailable`);
    return { at: start + offset, code: a.code, order };
  }).sort((a, b) => b.at - a.at || b.order - a.order);
  for (const a of insertions) source = source.slice(0, a.at) + a.code + source.slice(a.at);
  return source;
}

/** Generated source is frozen outside the measured invocation, then rechecked by its loader. */
export function transcriptPhasePreload(root: string, sourceRoot = resolve(import.meta.dir, "../..")): { preload: string; directory: string; failure: string; map: string } {
  const directory = join(root, "phase-slots"), map = join(root, "phase-sources.json"), preload = join(root, "transcript-phases.ts"), failure = join(root, "phase-error.txt");
  mkdirSync(directory, { mode: 0o700 }); writeFileSync(failure, "", { mode: 0o600 });
  const sources: Record<string, { file: string; hash: string; contents: string }> = {};
  for (const file of Object.keys(transcriptPhaseAnchors)) {
    const original = readFileSync(join(sourceRoot, file), "utf8");
    const contents = instrumentTranscriptSource(file, original);
    new Bun.Transpiler({ loader: file.endsWith(".js") ? "js" : "ts" }).transformSync(contents);
    sources[join(sourceRoot, file)] = { file, hash: createHash("sha256").update(original).digest("hex"), contents };
  }
  writeFileSync(map, JSON.stringify(sources), { mode: 0o600 });
  const worker = join(sourceRoot, "src/session-brief-worker.ts");
  writeFileSync(preload, `import {openSync,writeSync,closeSync,readFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const directory=${JSON.stringify(directory)},failure=${JSON.stringify(failure)},worker=${JSON.stringify(worker)},preload=${JSON.stringify(preload)};
const sources=JSON.parse(readFileSync(${JSON.stringify(map)},'utf8')), role=Number(process.argv[1]===worker), fd=openSync(directory+'/'+process.pid+'.slots','wx',0o600);
const rows=new Map(), watched=new WeakSet();let marks=0,cost=0,loader=0;
const fail=(message)=>{appendFileSync(failure,message+'\\n');};
const note=(phase,value=0)=>{
 if(marks>=${MAX_PHASE_MARKS}){if(phase!==52){if(!rows.has(52))note(52,marks);return;}}
 const began=performance.now(),at=performance.timeOrigin+began,cpu=process.resourceUsage();
 const before=rows.get(phase),row={phase,pid:process.pid,ppid:process.ppid,role,count:(before?.count??0)+1,firstAt:before?.firstAt??at,lastAt:at,firstUser:before?.firstUser??cpu.userCPUTime,lastUser:cpu.userCPUTime,firstSystem:before?.firstSystem??cpu.systemCPUTime,lastSystem:cpu.systemCPUTime,value,observerMs:cost,loaderMs:loader};
 const encoded=Buffer.from(JSON.stringify(row));if(encoded.length>=${PHASE_SLOT_BYTES}){fail('transcript phase slot overflow');return;}
 const slot=Buffer.alloc(${PHASE_SLOT_BYTES},32);encoded.copy(slot);slot[slot.length-1]=10;
 try{if(writeSync(fd,slot,0,slot.length,phase*${PHASE_SLOT_BYTES})!==slot.length)fail('transcript phase short write');}catch{fail('transcript phase write failed');}
 rows.set(phase,row);marks++;cost+=performance.now()-began;
};
globalThis.__amemTranscriptPhase=note;
globalThis.__amemWatchPhaseDb=(db,start,end)=>{if(watched.has(db))return;watched.add(db);const original=db.transaction.bind(db);db.transaction=fn=>{const run=original(fn),wrap=call=>(...args)=>{note(start);try{return call(...args);}finally{note(end);}};const out=wrap(run);for(const kind of ['immediate','deferred','exclusive'])if(typeof run[kind]==='function')out[kind]=wrap(run[kind].bind(run));return out;};};
Bun.plugin({name:'transcript-phase-observer',setup(builder){builder.onLoad({filter:/(hooks|session-brief-worker|hook-transcript|capture|metrics)\\.ts$|[/]bin[/]amem\\.js$/},({path})=>{
 const began=performance.now(),source=sources[path];if(!source)return;
 if(createHash('sha256').update(readFileSync(path,'utf8')).digest('hex')!==source.hash){fail('transcript phase source changed: '+source.file);throw Error('transcript phase source changed');}
 loader+=performance.now()-began;note(51);return {loader:path.endsWith('.js')?'js':'ts',contents:source.contents};
});}});
const spawn=Bun.spawn.bind(Bun);Bun.spawn=(argv,options)=>{if(!Array.isArray(argv)||argv[0]!==process.execPath||argv[1]!=='--smol'||argv[2]!==worker)return spawn(argv,options);note(7);const child=spawn([argv[0],argv[1],'--preload',preload,...argv.slice(2)],options);note(8,child.pid);return child;};
const kill=process.kill.bind(process);process.kill=(pid,signal)=>{note(33,pid);try{return kill(pid,signal);}finally{note(34,pid);}};
process.once('exit',code=>{note(49,code);note(50,marks);});note(1,performance.timeOrigin+performance.now()-process.uptime()*1000);
`, { mode: 0o600 });
  return { preload, directory, failure, map };
}

export interface TranscriptPhaseRow { phase: number; pid: number; ppid: number; role: number; count: number; firstAt: number; lastAt: number; firstUser: number; lastUser: number; firstSystem: number; lastSystem: number; value: number; observerMs: number; loaderMs: number }
export function readTranscriptPhases(directory: string, onlyPid?: number): TranscriptPhaseRow[] {
  const files = readdirSync(directory); if (files.length > MAX_PHASE_PROCESSES) throw Error("transcript phase process bound exceeded");
  const rows: TranscriptPhaseRow[] = [];
  for (const name of files) {
    if (!/^[1-9][0-9]*[.]slots$/.test(name)) throw Error("transcript phase process receipt malformed");
    if (onlyPid !== undefined && name !== `${onlyPid}.slots`) continue;
    const file = join(directory, name); if (statSync(file).size > PHASE_SLOTS * PHASE_SLOT_BYTES || statSync(file).size % PHASE_SLOT_BYTES !== 0) throw Error("transcript phase file bound exceeded");
    const bytes = readFileSync(file);
    for (let at = 0; at < bytes.length; at += PHASE_SLOT_BYTES) {
      const slot = bytes.subarray(at, at + PHASE_SLOT_BYTES); if (slot.every(value => value === 0)) continue;
      let r: TranscriptPhaseRow; try { r = JSON.parse(slot.toString().trim()) as TranscriptPhaseRow; } catch { throw Error("transcript phase torn slot"); }
      const fields = ["phase", "pid", "ppid", "role", "count", "firstAt", "lastAt", "firstUser", "lastUser", "firstSystem", "lastSystem", "value", "observerMs", "loaderMs"] as const;
      if (Object.keys(r).length !== fields.length || fields.some(key => typeof r[key] !== "number" || !Number.isFinite(r[key]))
        || !Number.isSafeInteger(r.phase) || r.phase < 1 || r.phase >= transcriptPhases.length || r.phase * PHASE_SLOT_BYTES !== at
        || !Number.isSafeInteger(r.pid) || r.pid <= 0 || r.pid !== Number(name.split(".")[0]) || ![0, 1].includes(r.role)
        || !Number.isSafeInteger(r.count) || r.count < 1 || r.count > MAX_PHASE_MARKS + 1 || r.lastAt < r.firstAt
        || !Number.isSafeInteger(r.ppid) || r.ppid < 0 || r.firstAt < 0 || r.firstUser < 0 || r.firstSystem < 0
        || r.lastUser < r.firstUser || r.lastSystem < r.firstSystem || r.observerMs < 0 || r.loaderMs < 0) throw Error("transcript phase numeric receipt malformed");
      rows.push(r);
    }
  }
  return rows;
}
