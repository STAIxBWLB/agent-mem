#!/usr/bin/env python3
"""Measurement-only task123 controller: twenty fixed sequential attempts, never a fix or a retry loop."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

COUNT = 20
SCOPES = ['src', 'scripts', 'test', 'package.json', 'bun.lock', '.bun-version', '.github/workflows/task-123-measure.yml', 'docs/bench/r2-baseline.json']
HOST_KEYS = ('CI', 'GITHUB_ACTIONS', 'RUNNER_OS')
EXPECTED_HOST = {'CI': 'true', 'GITHUB_ACTIONS': 'true', 'RUNNER_OS': 'macOS'}

def dump(file, value):
    file.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')

def fingerprint():
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    if head != os.environ.get('TASK123_SOURCE_SHA'):
        raise RuntimeError('task123 source head differs from the pinned PR head; fix the checkout before measuring')
    subprocess.run(['git', 'diff', '--exit-code', head, '--', *SCOPES], check=True, stdout=subprocess.DEVNULL)
    digest = hashlib.sha256()
    files = subprocess.check_output(['git', 'ls-files', '-z', *SCOPES]).split(b'\0')
    for raw in sorted(value for value in files if value):
        digest.update(raw + b'\0')
        with Path(os.fsdecode(raw)).open('rb') as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b''):
                digest.update(chunk)
        digest.update(b'\0')
    return {'head': head, 'sha256': digest.hexdigest()}

def run(argv, name, out, env):
    start = time.monotonic()
    with (out / (name + '.stdout.log')).open('wb') as stdout, (out / (name + '.stderr.log')).open('wb') as stderr:
        code = subprocess.run(argv, env=env, stdout=stdout, stderr=stderr).returncode
    return {'command': argv, 'exitCode': code, 'seconds': round(time.monotonic() - start, 3)}

def objects(file):
    decoder = json.JSONDecoder()
    if not file.exists():
        return
    with file.open(errors='replace') as stream:
        for number, line in enumerate(stream, 1):
            start = line.find('{')
            if start < 0:
                continue
            try:
                value, _ = decoder.raw_decode(line[start:])
            except ValueError:
                continue
            if isinstance(value, dict) and 'diagnostic' in value:
                yield number, value

def analyze(out, index):
    invocations, trace_rows, r1, slow, metrics = [], [], [], [], []
    advisory = 0
    errors = []
    for name in ['budget.stdout.log', 'budget.stderr.log', 'slow-store.stdout.log', 'slow-store.stderr.log']:
        file = out / name
        if file.exists():
            for needle in ['hook RSS provenance unknown', 'transcript summaries not durable within 64']:
                if needle in file.read_text(errors='replace'):
                    errors.append(needle)
        for number, value in objects(file):
            kind = value.get('diagnostic')
            value_ref = {'file': name, 'line': number}
            if kind == 'transcript-budget-invocation':
                invocations.append((value, value_ref))
            elif kind == 'task123-phase-invocation':
                trace_rows.append((value, value_ref))
            elif kind == 'transcript-R1':
                r1.append(value)
            elif kind == 'transcript-budget-stall-advisory':
                advisory += 1
            elif kind == 'task123-slow-store':
                slow.append(dict(value, log=value_ref))
            elif kind == 'task110-metrics' and str(value.get('case', '')).startswith('slow-store:'):
                metrics.append(value)
    trace_map = {(x['event'], x['logicalRun'], x['followUp']): (x, ref) for x, ref in trace_rows}
    unknown, wall, cases = 0, [], []
    for value, ref in invocations:
        metric = value.get('metric') or {}
        if isinstance(metric.get('wallMs'), (int, float)):
            wall.append(metric['wallMs'])
        sources = metric.get('rssSources') or {}
        invalid = sources.get('unavailable', 0) > 0
        unknown += int(invalid)
        traces, trace_ref = trace_map.get((value['event'], value['logicalRun'], value['followUp']), ({'traces': []}, {}))
        for trace in traces.get('traces', []):
            if invalid or trace.get('reaped') is False or trace.get('outputLate') or metric.get('wallMs', 0) > 300:
                cases.append({'event': value['event'], 'logicalRun': value['logicalRun'], 'followUp': value['followUp'],
                              'metric': metric, 'trace': trace, 'invocationLog': ref, 'traceLog': trace_ref})
    observed = {(value['event'], value['logicalRun'], value['followUp']) for value, _ in invocations}
    for key, (trace_row, ref) in trace_map.items():
        if key in observed:
            continue
        for trace in trace_row.get('traces', []):
            if trace.get('reaped') is False or trace.get('outputLate'):
                cases.append({'event': key[0], 'logicalRun': key[1], 'followUp': key[2], 'metric': None,
                              'trace': trace, 'traceLog': ref, 'note': 'Native invocation row missing, e.g. an earlier R1 failure; do not interpret as a pass.'})
    phase_records = [trace for row, _ in trace_rows for trace in row.get('traces', [])]
    summary = {'iteration': index, 'invocations': len(invocations), 'phaseInvocationRows': len(trace_rows),
               'workerRecords': len(phase_records), 'phaseRowsWithoutNativeInvocation': len(set(trace_map) - observed), 'workerRecordsWithoutObservedPhase': sum(not (x.get('trace') or {}).get('last') for x in phase_records),
               'rssUnknownInvocations': unknown, 'rssUnknownReported': 'hook RSS provenance unknown' in errors,
               'notDurableReported': 'transcript summaries not durable within 64' in errors,
               'maxHandlerWallMs': max(wall, default=None), 'over300ms': sum(x > 300 for x in wall),
               'abandonedWorkerRecords': sum(x.get('reaped') is False for x in phase_records),
               'stallAdvisoryRows': advisory, 'r1Observations': r1, 'cases': cases,
               'slowStoreCases': slow, 'slowStoreMetricSummaries': metrics,
               'note': 'Diagnostic/instrumented source, not advisory-removal acceptance; postExitSurvivalMs is observation latency, not a precise death time.'}
    dump(out / 'analysis.json', summary)
    return summary

def analysis_probe(out):
    with tempfile.TemporaryDirectory(prefix='analysis-probe-', dir=out) as temporary:
        folder = Path(temporary)
        phase = {'diagnostic': 'task123-phase-invocation', 'event': 'Stop', 'logicalRun': 1, 'followUp': 0,
                 'traces': [{'reaped': False, 'trace': {'last': {'phase': 'store.append.enter'}}}]}
        invocation = {'diagnostic': 'transcript-budget-invocation', 'event': 'Stop', 'logicalRun': 1, 'followUp': 0,
                      'metric': {'wallMs': 301, 'rssSources': {'unavailable': 2}}}
        (folder / 'budget.stdout.log').write_text(json.dumps(phase) + '\n' + json.dumps(invocation) + '\n')
        (folder / 'budget.stderr.log').write_text('hook RSS provenance unknown\n')
        measured = analyze(folder, 0)
        if measured['rssUnknownInvocations'] != 1 or measured['over300ms'] != 1 or len(measured['cases']) != 1:
            raise RuntimeError('task123 analyzer missed a known provenance/wall failure; fix the parser before measuring')
        (folder / 'budget.stdout.log').write_text(json.dumps(phase) + '\n')
        censored = analyze(folder, 0)
        if censored['phaseRowsWithoutNativeInvocation'] != 1 or len(censored['cases']) != 1:
            raise RuntimeError('task123 analyzer dropped a phase preceding an R1 abort; fix the parser before measuring')
    return {'command': ['task123', 'known-failure-analysis-probe'], 'exitCode': 0}

def preflight(out):
    host = {key: os.environ.get(key) for key in HOST_KEYS}
    source = fingerprint()
    commands = {'analysis-probe': analysis_probe(out)}
    env = dict(os.environ)
    env.pop('TASK123_TRACE_DIR', None)
    for name, argv in [
        ('install', ['bun', 'install', '--frozen-lockfile']),
        ('typecheck', ['bun', 'x', 'tsc', '--noEmit']),
        ('boundary', ['bun', 'scripts/check-boundary.ts']),
        ('phase-probe', ['bun', 'test', '--timeout', '20000', 'test/task-123-phase.test.ts']),
        ('full-tests', ['bun', 'test', '--max-concurrency', '2', '--timeout', '20000']),
        ('pack', ['npm', 'pack', '--dry-run']),
    ]:
        commands[name] = run(argv, 'preflight-' + name, out, env)
        print('preflight', name, 'exit', commands[name]['exitCode'], flush=True)
        if commands[name]['exitCode'] and name in ['install', 'typecheck', 'boundary', 'phase-probe']:
            break
    can_measure = host == EXPECTED_HOST and all(commands.get(name, {}).get('exitCode') == 0 for name in ['install', 'typecheck', 'boundary', 'phase-probe', 'analysis-probe'])
    ok = can_measure and len(commands) == 7 and all(x['exitCode'] == 0 for x in commands.values())
    result = {'host': host, 'source': source, 'commands': commands, 'canMeasure': can_measure, 'ok': ok,
              'note': 'A full-test failure is retained and prevents an acceptance claim; it does not hide the separate diagnostic attempts if the probe/source checks pass.'}
    dump(out / 'preflight.json', result)
    return 0 if ok else 1

def measure(out):
    pre = json.loads((out / 'preflight.json').read_text())
    if not pre.get('canMeasure'):
        dump(out / 'summary.json', {'measurementComplete': False, 'requested': COUNT, 'recorded': 0,
                                  'reason': 'phase/source preflight failed; fix the measurement setup before using results', 'removalEligible': False})
        return 1
    results = []
    for index in range(1, COUNT + 1):
        iteration = out / ('iteration-%02d' % index)
        iteration.mkdir(mode=0o700, exist_ok=True)
        env = dict(os.environ, TASK123_TRACE_DIR=str(iteration / 'phase-files'))
        status = {'iteration': index, 'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
        start = time.monotonic()
        try:
            source = fingerprint()
            if source != pre['source'] or {key: os.environ.get(key) for key in HOST_KEYS} != EXPECTED_HOST:
                raise RuntimeError('task123 source/host changed; discard a pass interpretation and inspect the checkout')
            status['source'] = source
            status['budget'] = run(['bun', 'scripts/measure-transcript-budget.ts'], 'budget', iteration, env)
            status['slowStore'] = run(['bun', 'test', '--max-concurrency', '2', '--timeout', '20000', 'test/hook-transcript-worker.test.ts', '-t', 'a slow synchronous capture statement remains killable'], 'slow-store', iteration, env)
            if fingerprint() != source:
                raise RuntimeError('task123 source changed during measurement; inspect the checkout before using results')
            summary = analyze(iteration, index)
        except Exception as error:
            status['error'] = str(error)
            summary = {'iteration': index, 'censored': True, 'reason': str(error)}
        status['seconds'] = round(time.monotonic() - start, 3)
        dump(iteration / 'status.json', status)
        results.append({'status': status, 'analysis': summary})
        dump(out / 'iterations.json', results)
        dump(out / 'summary.json', {'requested': COUNT, 'recorded': len(results), 'measurementComplete': False,
                                   'removalEligible': False, 'iterations': results, 'note': 'Interim/censored until all twenty diagnostic attempts finish; no retry is added.'})
        print('task123 iteration', index, 'budget', status.get('budget', {}).get('exitCode'), 'slowStore', status.get('slowStore', {}).get('exitCode'),
              'unknown', summary.get('rssUnknownInvocations'), 'notDurable', summary.get('notDurableReported'), 'wallMax', summary.get('maxHandlerWallMs'), flush=True)
    complete = len(results) == COUNT and all(not x['analysis'].get('censored') for x in results)
    native_pass = all(x['status'].get('budget', {}).get('exitCode') == 0 and x['status'].get('slowStore', {}).get('exitCode') == 0 for x in results)
    final = {'nativeAndPairedTestsAllPassed': native_pass, 'source': pre['source'], 'host': pre['host'], 'preflightOK': pre['ok'], 'requested': COUNT, 'recorded': len(results),
             'measurementComplete': complete, 'removalEligible': False, 'iterations': results,
             'note': 'All fixed attempts and all failures retained; phase instrumentation can affect timing. This diagnosis never qualifies advisory removal or a production fix.'}
    dump(out / 'summary.json', final)
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as stream:
            stream.write('\n## Task123 diagnostic measurement\n\nRecorded %d/20. Complete=%s. PreflightOK=%s. Advisory removal eligible=false (instrumented diagnosis only).\n' % (len(results), complete, pre['ok']))
    return 0 if complete and native_pass else 1

if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[1] not in ['preflight', 'measure']:
        raise SystemExit('usage: python3 scripts/task-123-measure.py preflight|measure <absolute-output-dir>')
    output = Path(sys.argv[2]).resolve()
    output.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        code = preflight(output) if sys.argv[1] == 'preflight' else measure(output)
    except Exception as error:
        dump(output / ('preflight.json' if sys.argv[1] == 'preflight' else 'summary.json'),
             {'ok': False, 'canMeasure': False, 'measurementComplete': False, 'removalEligible': False,
              'reason': str(error), 'nextStep': 'Fix the pinned-source/host/probe setup before using this measurement.'})
        code = 1
    raise SystemExit(code)
