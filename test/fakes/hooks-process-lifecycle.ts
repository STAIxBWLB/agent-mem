/** Nonshipping source observation only. This never edits a target file or changes its branch/timer expressions. */
export function instrumentHookLifecycle(preload:string,receipt:string,timerLagEnabled=false):string {
  const worker=[
    ["exit = child.exited.then(code => { exited = true; return code; });","exit = child.exited.then(code => { exited = true;globalThis.__hookChildLife('exit',child.pid,'worker',{code}); return code; });"],
    ["    killed = true;","    killed = true;globalThis.__hookChildLife('kill-request',owned.pid,'worker');"],
    ["      const reaped = exited || !(await boundedWait(exit!)).late;","      globalThis.__hookChildLife('reap-start',owned.pid,'worker',{boundMs:REAP_BOUND_MS});const reaped = exited || !(await boundedWait(exit!)).late;globalThis.__hookChildLife('reap-end',owned.pid,'worker',{reaped:Number(reaped)});"],
    ["      const body = reaped ? await boundedWait(output!) : { late: true };","      const body = reaped ? await boundedWait(output!) : { late: true };globalThis.__hookChildLife('output-end',owned.pid,'worker',{late:Number(body.late),outputAvailable:Number(body.value!==undefined)});"],
    ["      const accounting = tracker!.finish(workerRawKB);","      const accounting = tracker!.finish(workerRawKB);globalThis.__hookChildLife('rss-finish',owned.pid,'worker',{...accounting.rssSources,kb:accounting.rssKB,rawKB:workerRawKB});"],
  ];
  const native=[
    ["    exited = true;","    exited = true;globalThis.__hookChildLife('exit',child.pid,'native',{code});"],
    ["    if (exited) return;","    if (exited) return;globalThis.__hookChildLife('kill-request',child.pid,'native');"],
    ["    await exit;","    globalThis.__hookChildLife('reap-start',child.pid,'native');await exit;"],
    ["    await rssReceipt;","    await rssReceipt;globalThis.__hookChildLife('reap-end',child.pid,'native',{reaped:Number(exited)});"],
    ["    if (observationFailed) usage.rssSources.unavailable++;","    if (observationFailed) usage.rssSources.unavailable++;globalThis.__hookChildLife('rss-finish',child.pid,'native',{source:selected.source,known:Number(selected.known),kb:selected.kb,rawKB:selected.rawKB,observationFailed:Number(observationFailed)});"],
  ];
  const replace=(anchor:string,value:string)=>{
    if(preload.split(anchor).length!==2)throw Error("Lifecycle preload anchor changed; update the exact test observer and rerun its controls");
    preload=preload.replace(anchor,value);
  };
  // ponytail:512 metadata receipts per CLI, with explicit truncation; larger invocations need a reviewed streaming observer.
  const timerState=timerLagEnabled?`let activeReapChild=0,lastTimer=null,timerSequence=0;`:"";
  const snapshots=timerLagEnabled?`if(kind==='worker'&&phase==='reap-start')activeReapChild=childPid;
if(kind==='worker'&&(phase==='reap-start'||phase==='reap-end'))values={...values,timerId:lastTimer?.timerId??null,timerDueMs:lastTimer?.timerDueMs??null,timerLagMs:lastTimer?.timerLagMs??null,timerCallbackAtMs:lastTimer?.timerCallbackAtMs??null,timerDelayMs:lastTimer?.timerDelayMs??null,timerWindowChildPid:lastTimer?.timerWindowChildPid??null};
if(kind==='worker'&&phase==='reap-end')activeReapChild=0;`:"";
  const timerObserver=timerLagEnabled?`const originalSetTimeout=globalThis.setTimeout;
globalThis.setTimeout=new Proxy(originalSetTimeout,{apply(target,self,args){const callback=args[0];if(typeof callback!=='function')return Reflect.apply(target,self,args);
const timerId=++timerSequence,timerWindowChildPid=activeReapChild,timerDelayMs=typeof args[1]==='number'&&Number.isFinite(args[1])?Math.max(1,args[1]):1,timerDueMs=performance.timeOrigin+performance.now()+timerDelayMs;
const observed=function(...values){const timerCallbackAtMs=performance.timeOrigin+performance.now();lastTimer={timerId,timerWindowChildPid,timerDelayMs,timerDueMs,timerCallbackAtMs,timerLagMs:timerCallbackAtMs-timerDueMs};life('timer-fired',timerWindowChildPid,'worker',lastTimer);return Reflect.apply(callback,this,values);};
return Reflect.apply(target,self,[observed,...args.slice(1)]);}});`:"";
  replace("note('preload');",`const receipts=[];let truncated=false;
${timerState}
const life=(phase,childPid,kind,values={})=>{${snapshots}if(receipts.length>=512){truncated=true;return;}receipts.push({phase,parentPid:process.pid,childPid,kind,atMs:performance.timeOrigin+performance.now(),...values});};
globalThis.__hookChildLife=life;
${timerObserver}
process.once('exit',()=>{if(truncated)receipts.push({phase:'truncated',parentPid:process.pid,childPid:0,kind:'worker',atMs:performance.timeOrigin+performance.now()});if(receipts.length)appendFileSync(${JSON.stringify(receipt)},receipts.map(row=>JSON.stringify(row)+'\\n').join(''),{mode:0o600});});
const transformLifecycle=(source,anchors)=>{for(const [anchor,replacement]of anchors){if(source.split(anchor).length!==2)throw Error('Child lifecycle observation anchor changed; update the exact test preload and rerun observer controls');source=source.replace(anchor,replacement);}return source;};
const workerLifecycle=source=>transformLifecycle(source,${JSON.stringify(worker)});
note('preload');`);
  const lines=preload.split("\n").filter(line=>line.startsWith(" return {loader:'ts',contents:source.replace(late,lateObserved)"));
  if(lines.length!==1)throw Error("Worker preload render changed; update the exact test observer and rerun its controls");
  const line=lines[0]!;replace(line,line.replace("contents:","contents:workerLifecycle(").slice(0,-2)+")};");
  replace("globalThis.__hookProcessNote=note;",`Bun.plugin({name:'observe-native-lifecycle',setup(builder){builder.onLoad({filter:/[/]hook-native\\.ts$/},({path})=>({loader:'ts',contents:transformLifecycle(readFileSync(path,'utf8'),${JSON.stringify(native)})}));}});
globalThis.__hookProcessNote=note;`);
  replace(" const child=original(argv,options);",` if(matched||native)life('spawn-attempt',0,native?'native':'worker');
 let child;try{child=original(argv,options);}catch(error){if(matched||native)life('spawn-failed',0,native?'native':'worker');throw error;}
 if(matched||native)life('spawn',child.pid,native?'native':'worker');`);
  return preload;
}
