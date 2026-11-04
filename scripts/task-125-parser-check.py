#!/usr/bin/env python3
"""Pure synthetic parser controls. Never run a hook or claim native acceptance."""
import argparse, copy, importlib.util, json
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--controller',type=Path,required=True);p.add_argument('--report',type=Path,required=True);a=p.parse_args()
spec=importlib.util.spec_from_file_location('task125_acceptance',a.controller);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
sources={'vmhwm':0,'vmpeakBound':0,'platformRusage':2,'rawFallback':0,'unavailable':0}
records=[];samples=[];groups=[]
for event in ['Stop','SessionEnd','StopBurst']:
    batches=[32,32,32,7] if event=='StopBurst' else [3]
    for logical in range(1,41):
        durable=0;offset=0
        for follow,new in enumerate(batches):
            durable+=new;offset+=new*100
            metric={'wallMs':90,'rssMB':60,'rssScope':'owned-images','rssSources':sources.copy(),'transcriptOffset':offset}
            records.append({'diagnostic':'transcript-budget-invocation','event':event,'logicalRun':logical,'followUp':follow,'wallMs':95,'exitCode':0,'stdoutBytes':0,'cliRssMB':40,'metric':metric})
            sample={'event':event,'logicalRun':logical,'followUp':follow,'wallMs':95,'rssMB':60,'recordedRssMB':60,'cliRssMB':40,'rssSources':sources.copy(),'durableSummaries':durable,'newSummaries':new,'offset':offset,'reasonOnlyStreak':0}
            samples.append(sample);records.append({'diagnostic':'transcript-budget-sample',**sample})
    groups.append({'event':event,'logicalRuns':40,'runs':40*len(batches),'wallPass':True,'rssPass':True,'rssGate':{'runner':'hosted-macos','pass':True,'ceiling':{'pass':True},'regression':{'pass':True,'p95MB':60},'wallMax':{'pass':True}}})
records.append({'diagnostic':'transcript-R1-summary','windowMs':2000,'invocations':len(samples),'aliveAtExit':0,'maxSurvivalMs':0})
records.append({'diagnostic':'budget-group','check':'transcript-hooks','attempt':1,'outcome':'pass','result':{'groups':groups,'samples':samples}})
def analyze(rows,status=None):
    return module.analyze('\n'.join(json.dumps(v) if isinstance(v,dict) else v for v in rows)+'\n','',status or {'exitCode':0,'cleanupOK':True,'timedOut':False})
positive=analyze(records); results={}
for name in ['rss-unknown','wall-over300','wall-nan','missing-sample','missing-call','duplicate-call','retry','boolean-attempt','rss-selector','incomplete','survivor','advisory','instrumented','malformed','process-failure']:
    rows=copy.deepcopy(records);status=None
    inv=next(v for v in rows if isinstance(v,dict) and v.get('diagnostic')=='transcript-budget-invocation')
    sample=next(v for v in rows if isinstance(v,dict) and v.get('diagnostic')=='transcript-budget-sample')
    if name=='rss-unknown':inv['metric']['rssSources']['unavailable']=1
    elif name=='wall-over300':inv['metric']['wallMs']=308
    elif name=='wall-nan':inv['metric']['wallMs']=float('nan')
    elif name=='missing-sample':rows.remove(sample)
    elif name=='missing-call':rows.remove(inv)
    elif name=='duplicate-call':rows.append(copy.deepcopy(inv))
    elif name=='retry':v=copy.deepcopy(rows[-1]);v['attempt']=2;rows.append(v)
    elif name=='boolean-attempt':rows[-1]['attempt']=True
    elif name=='rss-selector':sample['rssMB']=59;rows[-1]['result']['samples'][0]['rssMB']=59
    elif name=='incomplete':
        target=next(v for v in reversed(rows) if isinstance(v,dict) and v.get('diagnostic')=='transcript-budget-sample');target['newSummaries']=6;target['durableSummaries']=102
        rows[-1]['result']['samples'][-1]['newSummaries']=6;rows[-1]['result']['samples'][-1]['durableSummaries']=102
    elif name=='survivor':rows.append({'diagnostic':'transcript-R1','event':'Stop','logicalRun':1,'followUp':0,'survivors':1,'aliveAtExit':1,'postExitSurvivalMs':2000})
    elif name=='advisory':rows.append({'diagnostic':'transcript-budget-stall-advisory','event':'StopBurst'})
    elif name=='instrumented':rows.append({'diagnostic':'task123-worker'})
    elif name=='malformed':rows.append('{"diagnostic":broken')
    elif name=='process-failure':status={'exitCode':1,'cleanupOK':True}
    result=analyze(rows,status);results[name]={'eligible':result['eligible'],'issues':[v['kind'] for v in result['issues']]}
report={'syntheticOnly':True,'positiveEligible':positive['eligible'],'positiveIssues':positive['issues'],'mutants':results,'pass':positive['eligible'] and not any(v['eligible'] for v in results.values())}
a.report.parent.mkdir(parents=True,exist_ok=True);a.report.write_text(json.dumps(report,indent=2,allow_nan=False)+'\n');print(json.dumps({'parserControlsPass':report['pass'],'mutants':len(results)}));raise SystemExit(0 if report['pass'] else 1)
