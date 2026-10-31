import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Test-only source probes. Numeric stderr survives an owned worker's deadline kill.
 * No input, paths, stamps, project ids or exception messages enter the diagnostic. */
export function hookRecoveryDiagnostic(root: string): NodeJS.ProcessEnv {
  const preload = join(root, "recovery-diagnostic.ts"), worker = resolve(import.meta.dir, "../../src/session-brief-worker.ts");
  writeFileSync(preload, `import {readFileSync,writeSync} from 'node:fs';
const note=(stage,...values)=>writeSync(2,JSON.stringify([stage,...values.map(v=>Number.isFinite(v)?Math.round(v*100)/100:-999)])+'\\n');
globalThis.__recoveryNote=note;
Bun.plugin({name:'numeric-recovery-diagnostic',setup(b){b.onLoad({filter:/(hooks|hook-spool|session-brief-worker)\\.ts$/},({path})=>{
 let contents=readFileSync(path,'utf8');
 const add=(needle,code)=>{if(contents.split(needle).length!==2)throw new Error('recovery diagnostic anchor changed');contents=contents.replace(needle,code+needle);};
 if(path.endsWith('/hooks.ts')){
 add('  let pending: PendingHookCapture | undefined, full = false;', 'globalThis.__recoveryNote(1);');
 add('  const cwd = realPath(options.cwd), scope = hookCaptureScope(cwd, base);','globalThis.__recoveryNote(2,deadline-performance.now());');
 add('    const project = resolveAlias(base, identity.value);','globalThis.__recoveryNote(3,remaining());');
 add('    // The current SessionStart is durable in its bounded reserve.','globalThis.__recoveryNote(4,remaining(),Number(full));');
 add('    const brief = await sessionStartBrief(','globalThis.__recoveryNote(5,remaining());');
 add('    result.pending = !!pending && !result.captured;','globalThis.__recoveryNote(6,remaining());');
 add('  const workDeadline = deadline - WORKER_CLEANUP_MS;','globalThis.__recoveryNote(7,deadline-performance.now());');
 add('    if (!answer || !answer[1]) return result;','globalThis.__recoveryNote(8,workDeadline-performance.now(),Number(!!answer),answer?.[1]?.length??0);');
 }else if(path.endsWith('/session-brief-worker.ts')){
 add('    if (remaining() <= 0) stop();','globalThis.__recoveryNote(10,remaining());');
 add('    let captured = false;','globalThis.__recoveryNote(11,remaining());');
 add('        captured = drained.captured.includes(options.current);','globalThis.__recoveryNote(12,remaining(),drained.captured.length,drained.blocked);');
 }else{
 add('  if (!stamp || options.expectedScope !== undefined && options.expectedScope !== stamp)','globalThis.__recoveryNote(20,options.timeRemaining?.()??-1,Number(!!stamp),Number(options.expectedScope===undefined||options.expectedScope===stamp));');
 add('  const policy = createStandalonePolicy(options.policy), dir = directory(base);','let __seen=0,__cwd=0,__stamp=0;');
 const filter='    const m = namePattern.exec(row.name); return m && m[2] === hash(cwd) && m[3] === stamp;';
 if(contents.split(filter).length!==2)throw new Error('recovery stamp anchor changed');
 contents=contents.replace(filter,'    const m=namePattern.exec(row.name);__seen++;if(m&&m[2]===hash(cwd)){__cwd++;if(m[3]===stamp)__stamp++;}return m&&m[2]===hash(cwd)&&m[3]===stamp;');
 add('  let remaining = DRAIN_BYTES, blocked = 0;','globalThis.__recoveryNote(26,__seen,__cwd,__stamp);');
 add('    if (options.timeRemaining && options.timeRemaining() < 8','globalThis.__recoveryNote(21,options.timeRemaining?.()??-1,captured.length,blocked);');
 add('      append(input, hash(record.bytes));','globalThis.__recoveryNote(22,options.timeRemaining?.()??-1);');
 add('      if (owns(claim)) { rmSync(claim.file); captured.push(name); }','globalThis.__recoveryNote(23,options.timeRemaining?.()??-1);');
 const caught='    } catch { blocked++; } // Transient failure';
 if(contents.split(caught).length!==2)throw new Error('recovery catch anchor changed');
 contents=contents.replace(caught,'    } catch(error) { globalThis.__recoveryNote(24, /lock|busy/i.test(error?.message??"")?1:2); blocked++; } // Transient failure');
 add('  const queued = inventory.filter(row => !retired.has(row.name));','globalThis.__recoveryNote(25,inventory.length,retired.size);');
 add('  const name = \`hook-\${hash(cwd)}-\${scope ?? \"0\".repeat(64)}-\${nonce}.json\`, temporary = join(writing, name);','globalThis.__recoveryNote(27,Number(deferred),Number(backlog));');
 }
 return {loader:'ts',contents};});}});
const spawn=Bun.spawn.bind(Bun);
Bun.spawn=(argv,options)=>Array.isArray(argv)&&argv[2]===${JSON.stringify(worker)}?spawn([argv[0],argv[1],'--preload',${JSON.stringify(preload)},...argv.slice(2)],{...options,stderr:'inherit'}):spawn(argv,options);
`, { mode: 0o600 });
  return { BUN_OPTIONS: `--preload=${preload}` };
}
