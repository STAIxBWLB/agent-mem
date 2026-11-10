/** Test-side loader only: observes the existing CLI deadline and transport phase seam. */
export function cadenceDiagnosticPrelude(home: string): string {
  return `
if(process.env.HOME!==${JSON.stringify(home)})throw Error("cadence diagnostics need the isolated fixture HOME; run this test through hookFixture");
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

export interface CadencePhase { stage: string; elapsedMs: number; deadlineMs?: number; stops?: unknown; [key: string]: unknown }
export interface CadenceStop { deadlineMs: number; cause: string | null; aborted: boolean }
export interface CadenceCallDiagnostic {
  diagnostic: "cadence-test-call"; call: number; command: string; ifDue: boolean; force: boolean;
  elapsedMs: number; exitCode: number; signalCode: string | number | null;
  outcome: Record<string, unknown>; phases: CadencePhase[];
  observedDeadlinesMs: number[]; stops: CadenceStop[] | null; stopStateComplete: boolean;
}
export function collectCadenceCallDiagnostic(input: {
  call: number; command: string; ifDue: boolean; force: boolean; elapsedMs: number; exitCode: number;
  signalCode?: unknown; stdout: string; stderr: string;
}): CadenceCallDiagnostic {
  const phases = input.stderr.split("\n").flatMap(line => {
    try {
      const value = JSON.parse(line);
      return value?.diagnostic === "cadence-child-phase" && typeof value.stage === "string" && Number.isFinite(value.elapsedMs) ? [value as CadencePhase] : [];
    } catch { return []; }
  });
  let outcome: Record<string, unknown>;
  try {
    const value = JSON.parse(input.stdout);
    outcome = { ok: value.ok ?? null, skipped: value.skipped ?? null, error: value.error ?? null, placementPublication: value.placementPublication ?? null };
  } catch { outcome = { json: false }; }
  const snapshot = phases.findLast(row => row.stage === "cli-finished")?.stops;
  const stops = Array.isArray(snapshot) && snapshot.every(stop => stop && Number.isFinite(stop.deadlineMs) && stop.deadlineMs > 0
    && (stop.cause === null || typeof stop.cause === "string") && typeof stop.aborted === "boolean") ? snapshot as CadenceStop[] : null;
  return { diagnostic: "cadence-test-call", call: input.call, command: input.command, ifDue: input.ifDue, force: input.force,
    elapsedMs: input.elapsedMs, exitCode: input.exitCode, signalCode: typeof input.signalCode === "string" || typeof input.signalCode === "number" ? input.signalCode : null,
    outcome, phases, observedDeadlinesMs: phases.flatMap(row => row.stage === "stop-created" && Number.isFinite(row.deadlineMs) && row.deadlineMs! > 0 ? [row.deadlineMs!] : []),
    stops, stopStateComplete: stops !== null };
}
export interface CadenceFailureDiagnostic { diagnostic: "cadence-test-failure"; lastCall: number | null; calls: readonly CadenceCallDiagnostic[] }
/** Report only a failing test, not an expected command refusal; never replace the assertion error. */
export async function withCadenceFailureDiagnostics<T>(calls: readonly CadenceCallDiagnostic[], work: () => T | Promise<T>,
  emit: (record: CadenceFailureDiagnostic) => void = record => console.error(JSON.stringify(record))): Promise<T> {
  try { return await work(); }
  catch (error) {
    try { emit({ diagnostic: "cadence-test-failure", lastCall: calls.at(-1)?.call ?? null, calls: [...calls] }); }
    catch { /* A broken diagnostic sink cannot mask the original test failure. */ }
    throw error;
  }
}
