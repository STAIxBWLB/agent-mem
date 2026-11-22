/** Remaining native deadline (ms) from the supervisor argv, or undefined when the shape is not the expected one. */
export function supervisorRemainingMs(command: unknown): number | undefined {
  if (!Array.isArray(command) || command[0] !== "/bin/sh" || command[1] !== "-c" || typeof command[2] !== "string"
    || !command[2].startsWith("marker=$1; seconds=$2; shift 2; leader=$$") || command[3] !== "amem-hook-native"
    || typeof command[5] !== "string" || !/^[0-9]+(?:[.][0-9]+)?$/.test(command[5])) return undefined;
  const ms = Number(command[5]) * 1000;
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms * 10) / 10 : undefined;
}

/** Nonshipping source observation only. This never edits a target file or changes its branch/timer expressions. */
export function instrumentHookLifecycle(preload:string,receipt:string,fixtureOwner = false,entryBase = ""):string {
  const worker=[
    ["if (parsed.rssTelemetryValid !== true) tracker!.invalidate();", "if (parsed.rssTelemetryValid !== true) { globalThis.__hookRssWireValid=false;tracker!.invalidate(); }"],
    ["exit = child.exited.then(code => { exited = true; return code; });","exit = child.exited.then(code => { exited = true;globalThis.__hookChildLife('exit',child.pid,'worker',{code}); return code; });"],
    ["    killed = true;","    killed = true;globalThis.__hookChildLife('kill-request',owned.pid,'worker');"],
    ["      const reaped = exited || !(await boundedWait(exit!)).late;","      globalThis.__hookChildLife('reap-start',owned.pid,'worker',{boundMs:REAP_BOUND_MS});const reaped = exited || !(await boundedWait(exit!)).late;globalThis.__hookChildLife('reap-end',owned.pid,'worker',{reaped:Number(reaped)});"],
    ["      const body = reaped ? await boundedWait(output!) : { late: true };","      const body = reaped ? await boundedWait(output!) : { late: true };globalThis.__hookChildLife('output-end',owned.pid,'worker',{late:Number(body.late),outputAvailable:Number(body.value!==undefined)});"],
    ["      const accounting = tracker!.finish(workerRawKB);","      const accounting = tracker!.finish(workerRawKB);globalThis.__hookChildLife('rss-finish',owned.pid,'worker',{...accounting.rssSources,kb:accounting.rssKB,rawKB:workerRawKB,telemetryValid:Number(globalThis.__hookRssWireValid!==false)});"],
  ];
  const native=[
    ["    exited = true;","    exited = true;globalThis.__hookChildLife('exit',child.pid,'native',{code});"],
    ["    if (exited) return;","    if (exited) return;globalThis.__hookChildLife('kill-request',child.pid,'native');"],
    ["    await exit;","    globalThis.__hookChildLife('reap-start',child.pid,'native');await exit;"],
    ["    await rssReceipt;","    await rssReceipt;globalThis.__hookChildLife('reap-end',child.pid,'native',{reaped:Number(exited),telemetryValid:Number(receiptValid)});"],
    ["    if (observationFailed) usage.rssSources.unavailable++;","    if (observationFailed) usage.rssSources.unavailable++;globalThis.__hookChildLife('rss-finish',child.pid,'native',{source:selected.source,known:Number(selected.known),kb:selected.kb,rawKB:selected.rawKB,observationFailed:Number(observationFailed),telemetryValid:Number(receiptValid)});"],
  ];
  // Only the synthetic timeout command needs its detached supervisor's identity; production source is unchanged.
  if (fixtureOwner) native.push(["'marker=$1; seconds=$2; shift 2; leader=$$'", "'marker=$1; seconds=$2; shift 2; leader=$$; export leader'"]);
  const replace=(anchor:string,value:string)=>{
    if(preload.split(anchor).length!==2)throw Error("Lifecycle preload anchor changed; update the exact test observer and rerun its controls");
    preload=preload.replace(anchor, () => value);
  };
  // ponytail:512 metadata receipts per CLI, with explicit truncation; larger invocations need a reviewed streaming observer.
  replace("note('preload');",`const receipts=[];let truncated=false;
receipts.push({phase:'origin',parentPid:process.pid,childPid:0,kind:'worker',atMs:performance.timeOrigin});
const life=(phase,childPid,kind,values={})=>{if(receipts.length>=512){truncated=true;return;}receipts.push({phase,parentPid:process.pid,childPid,kind,atMs:performance.timeOrigin+performance.now(),...values});};
globalThis.__hookChildLife=life;
Bun.plugin({name:'observe-rss-wire-validity',setup(builder){builder.onLoad({filter:/[/]hook-rss-wire[.]ts$/},({path})=>{
 const source=readFileSync(path,'utf8'),start=source.indexOf('  frame(value: unknown): void {'),end=source.indexOf('  /** #226 Q2:');
 if(start<0||end<=start)throw Error('RSS wire observation anchor changed; update the diagnostic preload');
 const frame=source.slice(start,end);
 if(!frame.includes('this.invalid = true'))throw Error('RSS wire invalidation anchor changed; update the diagnostic preload');
 return {loader:'ts',contents:source.slice(0,start)+frame.replaceAll('this.invalid = true;','{this.invalid = true;globalThis.__hookRssWireValid=false;}')+source.slice(end)};
});}});
process.once('exit',()=>{if(truncated)receipts.push({phase:'truncated',parentPid:process.pid,childPid:0,kind:'worker',atMs:performance.timeOrigin+performance.now()});if(receipts.length)appendFileSync(${JSON.stringify(receipt)},receipts.map(row=>JSON.stringify(row)+'\\n').join(''),{mode:0o600});});
const transformLifecycle=(source,anchors)=>{for(const [anchor,replacement]of anchors){if(source.split(anchor).length!==2)throw Error('Child lifecycle observation anchor changed; update the exact test preload and rerun observer controls');source=source.replace(anchor,()=>replacement);}return source;};
const workerLifecycle=source=>transformLifecycle(source,${JSON.stringify(worker)});
note('preload');`);
  const lines=preload.split("\n").filter(line=>line.startsWith(" return {loader:'ts',contents:source.replace(late,lateObserved)"));
  if(lines.length!==1)throw Error("Worker preload render changed; update the exact test observer and rerun its controls");
  const line=lines[0]!;replace(line,line.replace("contents:","contents:workerLifecycle(").slice(0,-2)+")};");
  replace("globalThis.__hookProcessNote=note;",`Bun.plugin({name:'observe-native-lifecycle',setup(builder){builder.onLoad({filter:/[/]hook-native\\.ts$/},({path})=>({loader:'ts',contents:transformLifecycle(readFileSync(path,'utf8'),${JSON.stringify(native)})}));}});
let lastWorkerRemainingMs;
globalThis.__hookProcessNote=(phase,values)=>{if((phase==='precheck'||phase==='late_check')&&Number.isFinite(values?.remainingUs)&&values.remainingUs>=0)lastWorkerRemainingMs=values.remainingUs/1000;note(phase,values);};`);
  replace(" const child=original(argv,options);",` if(matched||native)life('spawn-attempt',0,native?'native':'worker');
 let child;try{child=original(argv,options);}catch(error){if(matched||native)life('spawn-failed',0,native?'native':'worker');throw error;}
 if(matched||native){const remainingMs=native?supervisorRemainingMs(command):lastWorkerRemainingMs;life('spawn',child.pid,native?'native':'worker',remainingMs===undefined?{}:{spawnRemainingMs:remainingMs});}`);
  // #362: the spawn-site deadline is read only from the supervisor shape the fixture expects; any other shape omits it.
  replace("const original=Bun.spawn.bind(Bun);",`const supervisorRemainingMs=${supervisorRemainingMs.toString()};
const original=Bun.spawn.bind(Bun);`);
  if (fixtureOwner && entryBase) {
    // #362: fixture-owner only. The entry marker precedes the fixture body, including any delay a test injects into it.
    replace("'/bin/sh','-c',sleeper,", "'/bin/sh','-c','printf x > \"$1-entry.$leader\"; '+sleeper,");
    replace(" const sleeper=Bun.spawn(['/bin/sleep','30']", ` writeFileSync(${JSON.stringify(entryBase)}+'-entry.'+process.pid,'x',{mode:0o600});
 const sleeper=Bun.spawn(['/bin/sleep','30']`);
  }
  return preload;
}

const sessionDeadlineHooks = [
  ["  if (remaining() <= 0) { result.dropped = !pending; return result; }",
    "  const observedSessionRemaining = remaining(); if (observedSessionRemaining <= 0) { globalThis.__hookSessionNativeSkip(observedSessionRemaining); result.dropped = !pending; return result; }"],
  ["    const nativeRemaining = () => remaining() - 15;",
    "    const nativeRemaining = () => remaining() - 15; globalThis.__hookSessionNativeCallbacks.add(nativeRemaining);"],
];
const sessionDeadlineNative = [
  ['  if (!Number.isFinite(remaining) || remaining <= 1) throw new Error("native metadata deadline");',
    '  if (!Number.isFinite(remaining) || remaining <= 1) { if (Number.isFinite(remaining)) globalThis.__hookSessionNativeSkip(remaining, timeRemaining); throw new Error("native metadata deadline"); }'],
];
/** Exact branch observation, not a second deadline read or a production hook port. */
export function sessionNativeDeadlineSource(source: string, module: "hooks" | "native"): string {
  for (const [anchor, replacement] of module === "hooks" ? sessionDeadlineHooks : sessionDeadlineNative) {
    if (source.split(anchor!).length !== 2) throw Error("Session native deadline anchor changed; update the test observer before running the budget");
    source = source.replace(anchor!, replacement!);
  }
  return source;
}
/** Add only SessionStart deadline-skip evidence; the ordinary preload and full lifecycle mode remain separate. */
export function instrumentSessionNativeDeadline(preload: string): string {
  const replace = (anchor: string, replacement: string) => {
    if (preload.split(anchor).length !== 2) throw Error("Session deadline preload anchor changed; update the exact observer");
    preload = preload.replace(anchor, replacement);
  };
  replace("note('preload');", `const sessionCallbacks=new WeakSet();
globalThis.__hookSessionNativeCallbacks=sessionCallbacks;
globalThis.__hookSessionNativeSkip=(remaining,callback)=>{
 if(!Number.isFinite(remaining)||callback!==undefined&&!sessionCallbacks.delete(callback))return;
 note('session-native-deadline-skip',{remainingUs:Math.floor(remaining*1000)});
};
const sessionDeadlineSource=(source,anchors)=>{for(const [anchor,replacement] of anchors){if(source.split(anchor).length!==2)throw Error('Session native deadline anchor changed; update the test observer');source=source.replace(anchor,replacement);}return source;};
const sessionDeadlineHooks=source=>sessionDeadlineSource(source,${JSON.stringify(sessionDeadlineHooks)});
const sessionDeadlineNative=source=>sessionDeadlineSource(source,${JSON.stringify(sessionDeadlineNative)});
note('preload');`);
  const lines=preload.split("\n").filter(line=>line.startsWith(" return {loader:'ts',contents:") && line.includes("source.replace(late,lateObserved)"));
  if(lines.length!==1)throw Error("Session deadline hook loader anchor changed; update the test observer");
  const line=lines[0]!;replace(line,line.replace("contents:","contents:sessionDeadlineHooks(").slice(0,-2)+")};");
  if(preload.includes("name:'observe-native-lifecycle'")) {
    replace("contents:transformLifecycle(readFileSync(path,'utf8'),", "contents:transformLifecycle(sessionDeadlineNative(readFileSync(path,'utf8')),");
  } else {
    replace("globalThis.__hookProcessNote=note;", `Bun.plugin({name:'observe-session-native-deadline',setup(builder){builder.onLoad({filter:/[/]hook-native[.]ts$/},({path})=>({loader:'ts',contents:sessionDeadlineNative(readFileSync(path,'utf8'))}));}});
globalThis.__hookProcessNote=note;`);
  }
  return preload;
}
