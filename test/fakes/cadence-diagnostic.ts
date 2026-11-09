/** Test-side loader only: observes the existing CLI deadline and transport phase seam. */
export function cadenceDiagnosticPrelude(): string {
  return `
const {readFileSync: cadenceReadSource}=await import("node:fs");
const cadenceProbeStarted=performance.now();
const cadenceProbeSignals=[];
const cadenceProbeMark=(stage,fields={})=>console.error(JSON.stringify({diagnostic:"cadence-child-phase",stage,elapsedMs:performance.now()-cadenceProbeStarted,...fields}));
globalThis.__cadenceProbe={mark:cadenceProbeMark,signals:cadenceProbeSignals};
Bun.plugin({name:"cadence-test-observation",setup(build){
 build.onLoad({filter:/[/]sync-cadence[.]ts$/},({path})=>{
  let source=cadenceReadSource(path,"utf8");
  const anchor='  return { signal: AbortSignal.any([controller.signal, deadline]), dispose:';
  if(source.split(anchor).length!==2)throw Error("cadence diagnostic stop anchor changed; update test/fakes/cadence-diagnostic.ts against sync-cadence.ts before probing");
  source=source.replace(anchor,'  const cadenceObservedSignal=AbortSignal.any([controller.signal, deadline]); globalThis.__cadenceProbe.signals.push({deadlineMs:ms,signal:cadenceObservedSignal,cause:()=>cause}); globalThis.__cadenceProbe.mark("stop-created",{deadlineMs:ms}); cadenceObservedSignal.addEventListener("abort",()=>globalThis.__cadenceProbe.mark("stop-fired",{cause:cause??"unknown"}),{once:true}); return { signal: cadenceObservedSignal, dispose:');
  return{contents:source,loader:"ts"};
 });
 build.onLoad({filter:/[/]sync-placement-transport[.]ts$/},({path})=>{
  let source=cadenceReadSource(path,"utf8");
  const anchor='  return new PlacementTransport(store, opts, phase, testOnlyError).run();';
  if(source.split(anchor).length!==2)throw Error("cadence diagnostic transport anchor changed; update test/fakes/cadence-diagnostic.ts against sync-placement-transport.ts before probing");
  source=source.replace(anchor,'  globalThis.__cadenceProbe.mark("transport-enter"); const cadenceObservedPhase=async(name)=>{globalThis.__cadenceProbe.mark("transport:"+name);await phase?.(name);}; return new PlacementTransport(store, opts, cadenceObservedPhase, testOnlyError).run();');
  return{contents:source,loader:"ts"};
 });
 build.onLoad({filter:/[/]cli[.]ts$/},({path})=>{
  let source=cadenceReadSource(path,"utf8");
  const anchor='      placementWriters = activePlacementWriterContext(syncHome,fileURLToPath(new URL("..",import.meta.url)));';
  if(source.split(anchor).length!==2)throw Error("cadence diagnostic writer anchor changed; update test/fakes/cadence-diagnostic.ts against cli.ts before probing");
  source=source.replace(anchor,'      globalThis.__cadenceProbe.mark("writer-context-start");'+anchor+'globalThis.__cadenceProbe.mark("writer-context-end");');
  return{contents:source,loader:"ts"};
 });
}});
cadenceProbeMark("loader-ready");
`;
}
