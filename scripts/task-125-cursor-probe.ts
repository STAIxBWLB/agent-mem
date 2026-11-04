/** Task125 disposable baseline microprobe, run on dgx02 only. No product edits or diagnostic helper/mmap imports. */
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
const checkout = resolve(process.argv[2] ?? process.cwd());
const file = join(checkout, "src/hook-transcript.ts");
const records: Record<string, number>[] = [];
(globalThis as unknown as { task125Times: typeof records }).task125Times = records;
function once(source: string, anchor: string, replacement: string): string {
  if (source.split(anchor).length !== 2) throw Error("probe anchor differs: " + anchor);
  return source.replace(anchor, replacement);
}
Bun.plugin({ name: "task125-disposable-cursor-init-probe", setup(builder) {
  builder.onLoad({ filter: /[/]hook-transcript\.ts$/ }, args => {
    if (resolve(args.path) !== file) return;
    let source = readFileSync(file, "utf8");
    source = once(source, "function cursorDatabase(file: string, dev: string, ino: string, size: number): Database {", "function cursorDatabase(file: string, dev: string, ino: string, size: number): Database {\n const timing: Record<string, number> = {start: performance.now()};");
    source = once(source, "  const db = new Database(file);", "  timing.ownedChecksEnd = performance.now();\n  const db = new Database(file);\n timing.openEnd = performance.now();");
    source = once(source, '    db.run("PRAGMA busy_timeout = 0");', '    db.run("PRAGMA busy_timeout = 0");\n timing.pragmaEnd = performance.now();');
    source = once(source, "    db.transaction(() => {", "    timing.txCall = performance.now();\n db.transaction(() => {\n timing.txBodyStart = performance.now();");
    source = once(source, "    }).immediate();", "      timing.txBodyEnd = performance.now();\n }).immediate();\n timing.txReturn = performance.now();\n (globalThis as any).task125Times.push(timing);");
    return { loader: "ts", contents: source + "\nexport { cursorDatabase as task125CursorDatabase };\n" };
  });
} });
const imported = await import(pathToFileURL(file).href) as { task125CursorDatabase: (file: string, dev: string, ino: string, size: number) => Database };
const root = mkdtempSync(join(tmpdir(), "task125-cursor-probe-"));
const summaries: Record<string, unknown>[] = [];
const quantile = (xs: number[], q: number) => [...xs].sort((a,b) => a-b)[Math.ceil(q*xs.length)-1];
try {
  for (const [kind, count] of [["cold",40],["schemaless",40],["warm",120],["hot-journal",20]] as const) {
    const rows: Record<string, number>[] = [];
    const warm = join(root, "warm.db");
    if (kind === "warm") imported.task125CursorDatabase(warm,"1","1",1024).close();
    for (let index=0; index<count; index++) {
      const dbfile = kind === "warm" ? warm : join(root, kind + "-" + index + ".db");
      if (kind === "schemaless") new Database(dbfile).close();
      if (kind === "hot-journal") {
        imported.task125CursorDatabase(dbfile,"1","1",1024).close();
        const child = `import {Database} from 'bun:sqlite'; import {writeSync} from 'node:fs'; const db = new Database(process.argv.at(-1)); const put=db.query('INSERT INTO fallback VALUES (?,?)'); db.transaction(()=>{for(let i=0;i<1000;i++) put.run(i.toString(16).padStart(64,'0'),'2026-11-04T00:00:00.000Z');})(); const beforeSpill=db.query('PRAGMA main.cache_spill').get(); db.run('PRAGMA cache_size = 1'); db.run('PRAGMA main.cache_spill = 1'); const afterSpill=db.query('PRAGMA main.cache_spill').get(); writeSync(1,JSON.stringify({beforeSpill,afterSpill,pageSize:db.query('PRAGMA main.page_size').get(),pageCount:db.query('PRAGMA main.page_count').get(),journalMode:db.query('PRAGMA journal_mode').get(),synchronous:db.query('PRAGMA synchronous').get()})+'\\n'); if(afterSpill.cache_spill!==1)throw Error('spill threshold not configured'); db.run('BEGIN IMMEDIATE'); db.run('UPDATE cursor SET offset = 1'); db.run(\"UPDATE fallback SET at='2099-01-01T00:00:00.000Z'\"); writeSync(1,'task125-hot-journal-ready\\n'); process.kill(process.pid,'SIGKILL');`;
        const result = Bun.spawnSync([process.execPath,"-e",child,dbfile],{stdout:"pipe",stderr:"pipe",timeout:5000});
        console.log(JSON.stringify({diagnostic:"task125-hot-journal-child",index,signal:result.signalCode,exitCode:result.exitCode,stdout:result.stdout.toString().slice(0,1024),stderr:result.stderr.toString().slice(0,2048)}));
        if (result.signalCode !== "SIGKILL" || !result.stdout.toString().includes("task125-hot-journal-ready")) throw Error("fixture child was not SIGKILLed");
        if (result.exitCode === 0 || !existsSync(dbfile+"-journal")) throw Error("hot-journal child did not leave evidence: "+result.stderr.toString());
        const header = readFileSync(dbfile+"-journal");
        if (header.length <= 512 || header.subarray(0,8).toString("hex")!=="d9d505f920a163d7") throw Error("journal lacks a hot header; do not label as recovery");
      }
      const before=records.length;
      const db=imported.task125CursorDatabase(dbfile,"1","1",1024);
      const timing=records.at(-1)!;
      if (records.length!==before+1) throw Error("timing record missing");
      // Recovery verification is deliberately after the measured helper, never harness healing before it.
      const cursor = db.query('SELECT offset FROM cursor WHERE id=1').get() as {offset:number};
      if (cursor.offset!==0) throw Error("cursor recovery mismatch");
      if (kind === "hot-journal" && (db.query('SELECT COUNT(*) AS n FROM fallback').get() as {n:number}).n!==1000) throw Error("fallback rollback mismatch");
      if (kind === "hot-journal" && (db.query("SELECT COUNT(*) AS n FROM fallback WHERE at = ?").get("2026-11-04T00:00:00.000Z") as {n:number}).n!==1000) throw Error("fallback contents did not roll back");
      db.close();
      rows.push({ownedChecks:timing.ownedChecksEnd!-timing.start!,sqliteOpen:timing.openEnd!-timing.ownedChecksEnd!,pragma:timing.pragmaEnd!-timing.openEnd!,transactionBegin:timing.txBodyStart!-timing.txCall!,schemaBody:timing.txBodyEnd!-timing.txBodyStart!,transactionCommit:timing.txReturn!-timing.txBodyEnd!,total:timing.txReturn!-timing.start!});
    }
    const stats=Object.fromEntries(Object.keys(rows[0]!).map(key=>[key,{p50:quantile(rows.map(row=>row[key]!),.5),p95:quantile(rows.map(row=>row[key]!),.95),max:Math.max(...rows.map(row=>row[key]!))}]));
    const report={diagnostic:"task125-cursor-init-microprobe",kind,count,stats,samples:rows}; summaries.push(report); console.log(JSON.stringify(report));
  }
} finally { rmSync(root,{recursive:true,force:true}); }
