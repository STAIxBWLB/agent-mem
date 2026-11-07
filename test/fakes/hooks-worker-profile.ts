import { appendFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hookProcessObserver } from "./hooks-process-observer.ts";

/** Functional profiling only: this is never native140ms acceptance evidence. */
export function createHookWorkerProfile(root: string, sourceRoot: string, mode: "light" | "detailed", hostDeadlineMs = 1000) {
  if (!["light", "detailed"].includes(mode) || !Number.isSafeInteger(hostDeadlineMs) || hostDeadlineMs < 1 || hostDeadlineMs > 10000)
    throw Error("Worker profile window or mode is invalid; use a declared bounded functional profile window");
  const observer = hookProcessObserver(root, false, sourceRoot, true, mode === "detailed", true);
  const entry = join(root, "profile-hook.ts"), clockFile = join(root, "profile-clock.jsonl");
  writeFileSync(clockFile, "", { flag: "wx", mode: 0o600 });
  // Use the observer preload's existing fs import. No synchronous clock-file write occurs before/inside hookMain.
  appendFileSync(observer.preload, `
const profileClocks=[];let profileClockTruncated=false;
globalThis.__hookProfileClock=(phase,atMs)=>{if(profileClocks.length>=8){profileClockTruncated=true;return;}profileClocks.push({phase,pid:process.pid,atMs,observedAtMs:performance.timeOrigin+performance.now(),hostDeadlineMs:${hostDeadlineMs}});};
process.once('exit',()=>{if(profileClockTruncated)profileClocks.push({phase:9,pid:process.pid,atMs:performance.timeOrigin+performance.now(),observedAtMs:performance.timeOrigin+performance.now(),hostDeadlineMs:${hostDeadlineMs}});try{appendFileSync(${JSON.stringify(clockFile)},profileClocks.map(row=>JSON.stringify(row)+'\\n').join(''),{mode:0o600});}catch{/* Empty/missing clock evidence remains explicitly unavailable to the controller. */}});
`);
  const hooks = resolve(sourceRoot, "src/hooks.ts");
  writeFileSync(entry, `// Functional profile window ${hostDeadlineMs} ms; not the native hook budget.
const absoluteStart = performance.timeOrigin + performance.now() - process.uptime() * 1000;
globalThis.__hookProfileClock(1,absoluteStart);
const started=absoluteStart-performance.timeOrigin;
const {hookMain}=await import(${JSON.stringify(hooks)});
globalThis.__hookProfileClock(2,performance.timeOrigin+performance.now());
const output=await hookMain(process.argv.slice(2),started,{deadlineMs:${hostDeadlineMs}});
globalThis.__hookProfileClock(3,performance.timeOrigin+performance.now());
if(output)console.log(output);
`, { flag: "wx", mode: 0o600 });
  return { observer, entry, clockFile };
}
