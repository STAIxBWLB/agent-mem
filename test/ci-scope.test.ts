import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregate, ALLOWLIST, classify, draftDeferred, MACOS_DEFERRED_ERROR, main } from '../scripts/ci-scope.ts';

const event = (changed_files: number) => ({ pull_request: { changed_files } });
const listed = (filename: string, previous_filename?: string) => ({ filename, ...(previous_filename === undefined ? {} : { previous_filename }) });

describe('classify', () => {
  test('allows only the exact stamp path and requires an exact positive count', () => {
    expect(ALLOWLIST).toEqual(['docs/verified.json']);
    expect(classify([[listed('docs/verified.json')]], event(1), 'pull_request')).toBe(false);
    for (const files of [
      [[listed('docs/verified.json'), listed('README.md')]],
      [[listed('docs/verified.json', 'src/old.json')]],
      [[listed('README.md', 'docs/verified.json')]],
      [[]],
      [[], [listed('docs/verified.json')]],
      [[{ filename: 'docs/verified.json', status: 'renamed' }]],
      [[listed('docs/verified.json'), listed('docs/verified.json')]],
    ]) expect(classify(files, event(1), 'pull_request')).toBe(true);
    expect(classify([[listed('docs/verified.json')]], event(2), 'pull_request')).toBe(true);
    expect(classify([[listed('docs/verified.json')]], event(3000), 'pull_request')).toBe(true);
    expect(classify([[listed('docs/verified.json')]], event(1), 'push')).toBe(true);
  });
});

describe('aggregate', () => {
  const needs = (run_full: string, testResult: string, measureResult = testResult) => ({
    decision: { result: 'success', outputs: { run_full, macos_deferred: 'false' } },
    test: { result: testResult }, measure: { result: measureResult },
  });
  test('accepts only the planned success/skip combinations', () => {
    expect(aggregate(needs('true', 'success'), 'ubuntu-latest')).toEqual([]);
    expect(aggregate(needs('false', 'skipped'), 'ubuntu-latest')).toEqual([]);
    for (const bad of [
      needs('true', 'skipped'), needs('false', 'success'), needs('false', 'cancelled'),
      needs('true', 'failure'), needs('false', 'success', 'skipped'),
      { ...needs('false', 'skipped'), decision: { result: 'failure', outputs: { run_full: 'false' } } },
      { ...needs('false', 'skipped'), decision: { result: 'success', outputs: {} } },
      { ...needs('false', 'skipped'), measure: undefined },
      needs('maybe', 'skipped'),
    ]) expect(aggregate(bad, 'ubuntu-latest').length).toBeGreaterThan(0);
    expect(aggregate(needs('true', 'success'), 'windows-latest').length).toBeGreaterThan(0);
  });
});

// #402 AC3: draft, ready and unknown-draft inputs; a deferred plan never aggregates to success.
describe('macOS draft deferral', () => {
  const pr = (draft?: unknown) => ({ pull_request: { changed_files: 3, ...(draft === undefined ? {} : { draft }) } });
  const plan = (macos_deferred: string, macosResult: string, ubuntuResult = 'success') => ({
    decision: { result: 'success', outputs: { run_full: 'true', macos_deferred } },
    test: { result: ubuntuResult }, measure: { result: ubuntuResult },
    'test-macos': { result: macosResult }, 'measure-macos': { result: macosResult },
  });
  test('only an explicit draft flag on a pull_request defers macOS', () => {
    expect(draftDeferred(pr(true), 'pull_request')).toBe(true);
    expect(draftDeferred(pr(false), 'pull_request')).toBe(false);
    for (const unknown of [pr(), pr('true'), pr(1), pr(null), {}, undefined, null, []]) {
      expect(draftDeferred(unknown, 'pull_request')).toBe(false);
    }
    for (const name of ['push', 'workflow_dispatch', '']) expect(draftDeferred(pr(true), name)).toBe(false);
  });
  test('draft: macOS check fails with the deferred message, Ubuntu stays strict', () => {
    const errors = aggregate(plan('true', 'skipped'), 'macos-latest');
    expect(errors).toEqual([MACOS_DEFERRED_ERROR]);
    expect(MACOS_DEFERRED_ERROR).toBe('::error title=macOS deferred::draft PR; macOS runs when the PR is marked ready (gh pr ready)');
    expect(aggregate(plan('true', 'skipped'), 'ubuntu-latest')).toEqual([]);
    expect(aggregate(plan('true', 'skipped', 'failure'), 'ubuntu-latest').length).toBeGreaterThan(0);
    expect(aggregate(plan('true', 'success'), 'macos-latest')[0]).toBe(MACOS_DEFERRED_ERROR);
  });
  test('ready: both checks require their own jobs to succeed', () => {
    expect(aggregate(plan('false', 'success'), 'macos-latest')).toEqual([]);
    expect(aggregate(plan('false', 'success'), 'ubuntu-latest')).toEqual([]);
    expect(aggregate(plan('false', 'skipped'), 'macos-latest').length).toBeGreaterThan(0);
    expect(aggregate(plan('false', 'failure'), 'macos-latest').length).toBeGreaterThan(0);
    expect(aggregate(plan('false', 'success', 'failure'), 'macos-latest')).toEqual([]);
    for (const bad of ['', 'maybe', undefined]) {
      const needs = plan('false', 'success');
      (needs.decision.outputs as Record<string, unknown>).macos_deferred = bad;
      expect(aggregate(needs, 'macos-latest').length).toBeGreaterThan(0);
      expect(aggregate(needs, 'ubuntu-latest').length).toBeGreaterThan(0);
    }
  });
  test('draft CLI treats unknown or unreadable events as ready', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ci-scope-draft-'));
    const script = new URL('../scripts/ci-scope.ts', import.meta.url).pathname;
    const run = (path: string, eventName = 'pull_request') => Bun.spawnSync({
      cmd: [process.execPath, script, 'draft', path], env: { ...process.env, GITHUB_EVENT_NAME: eventName },
    }).stdout.toString().trim();
    try {
      const file = join(dir, 'event.json');
      await writeFile(file, JSON.stringify(pr(true)));
      expect(run(file)).toBe('macos_deferred=true');
      expect(run(file, 'push')).toBe('macos_deferred=false');
      await writeFile(file, JSON.stringify(pr(false)));
      expect(run(file)).toBe('macos_deferred=false');
      await writeFile(file, JSON.stringify(pr()));
      expect(run(file)).toBe('macos_deferred=false');
      await writeFile(file, '{bad');
      expect(run(file)).toBe('macos_deferred=false');
      expect(run(join(dir, 'missing'))).toBe('macos_deferred=false');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('CLI', () => {
  let dir = '';
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = ''; });
  test('fails safe for unreadable and malformed files, and aggregates environment input', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ci-scope-'));
    const files = join(dir, 'files.json');
    const eventFile = join(dir, 'event.json');
    await writeFile(files, JSON.stringify([[listed('docs/verified.json')]]));
    await writeFile(eventFile, JSON.stringify(event(1)));
    const oldLog = console.log;
    const output: string[] = [];
    console.log = (...args: unknown[]) => output.push(args.join(' '));
    try {
      expect(await main(['classify', files, eventFile], { GITHUB_EVENT_NAME: 'pull_request' })).toBe(0);
      expect(output.pop()).toBe('run_full=false');
      expect(await main(['classify', join(dir, 'absent'), eventFile], { GITHUB_EVENT_NAME: 'pull_request' })).toBe(0);
      expect(output.pop()).toBe('run_full=true');
      await writeFile(files, '{bad');
      expect(await main(['classify', files, eventFile], { GITHUB_EVENT_NAME: 'pull_request' })).toBe(0);
      expect(output.pop()).toBe('run_full=true');
      expect(await main(['classify', files, eventFile], {})).toBe(0);
      expect(output.pop()).toBe('run_full=true');
    } finally { console.log = oldLog; }
    expect(await main(['aggregate'], { CI_NEEDS: JSON.stringify(needsValue('false')), CI_OS: 'ubuntu-latest' })).toBe(0);
    expect(await main(['aggregate'], { CI_NEEDS: JSON.stringify(needsValue('false')), CI_OS: 'macos-latest' })).toBe(0);
    expect(await main(['aggregate'], { CI_NEEDS: JSON.stringify(needsValue('false')) })).toBe(1);
    expect(await main(['aggregate'], { CI_NEEDS: '{bad', CI_OS: 'ubuntu-latest' })).toBe(1);
  });

  test('runs as a CLI process and treats unreadable files and count/rename uncertainty as full', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ci-scope-process-'));
    const files = join(dir, 'files.json');
    const eventFile = join(dir, 'event.json');
    const script = new URL('../scripts/ci-scope.ts', import.meta.url).pathname;
    const run = (filePath: string, eventName = 'pull_request') => Bun.spawnSync({
      cmd: [process.execPath, script, 'classify', filePath, eventFile],
      env: { ...process.env, GITHUB_EVENT_NAME: eventName },
    });
    await writeFile(eventFile, JSON.stringify(event(1)));
    await writeFile(files, JSON.stringify([[listed('docs/verified.json')]]));
    expect(run(files).stdout.toString().trim()).toBe('run_full=false');
    expect(run(join(dir, 'missing')).stdout.toString().trim()).toBe('run_full=true');
    expect(run(dir).stdout.toString().trim()).toBe('run_full=true');
    await writeFile(files, JSON.stringify([[listed('docs/verified.json', 'README.md')]]));
    expect(run(files).stdout.toString().trim()).toBe('run_full=true');
    await writeFile(files, JSON.stringify([[listed('docs/verified.json')]]));
    await writeFile(eventFile, JSON.stringify(event(2)));
    expect(run(files).stdout.toString().trim()).toBe('run_full=true');
    expect(run(files, 'push').stdout.toString().trim()).toBe('run_full=true');
  });
});

function needsValue(run_full: string) {
  return { decision: { result: 'success', outputs: { run_full, macos_deferred: 'false' } }, test: { result: 'skipped' }, measure: { result: 'skipped' },
    'test-macos': { result: 'skipped' }, 'measure-macos': { result: 'skipped' } };
}

// The aggregate is a required status check: every unplanned result must fail, in either direction.
test('aggregate rejects every result combination except the two planned matrices', () => {
  const results = ['success', 'skipped', 'failure', 'cancelled', undefined];
  for (const decisionResult of results) for (const runFull of ['true', 'false', 'invalid', undefined]) {
    for (const testResult of results) for (const measureResult of results) {
      const needs = { decision: { result: decisionResult, outputs: { run_full: runFull, macos_deferred: 'false' } },
        test: { result: testResult }, measure: { result: measureResult },
        'test-macos': { result: testResult }, 'measure-macos': { result: measureResult } };
      const expected = decisionResult === 'success' && (
        runFull === 'true' && testResult === 'success' && measureResult === 'success'
        || runFull === 'false' && testResult === 'skipped' && measureResult === 'skipped');
      for (const os of ['ubuntu-latest', 'macos-latest']) expect(aggregate(needs, os).length === 0).toBe(expected);
      const deferred = { ...needs, decision: { result: decisionResult, outputs: { run_full: runFull, macos_deferred: 'true' } } };
      expect(aggregate(deferred, 'macos-latest').length).toBeGreaterThan(0);
      expect(aggregate(deferred, 'ubuntu-latest').length === 0).toBe(expected);
    }
  }
  expect(aggregate({ decision: { result: 'success', outputs: { run_full: 'true', macos_deferred: 'false' } },
    test: { result: 'skipped' }, measure: { result: 'success' } }, 'ubuntu-latest')[0]).toContain('test result=skipped decision=true');
  expect(aggregate(undefined, 'ubuntu-latest')[0]).toContain('inspect the job and rerun');
});

test('all malformed classifier shapes and non-PR events conservatively run everything', () => {
  const valid = [[listed('docs/verified.json')]];
  for (const payload of [undefined, null, {}, [], { pull_request: {} }, event(0), event(-1), event(1.5), event(NaN)]) {
    expect(classify(valid, payload, 'pull_request')).toBe(true);
  }
  for (const files of [null, {}, [], [null], [[null]], [[{}]], [[{ filename: 1 }]], [[listed('/docs/verified.json')]],
    [[listed('docs/verified.json'), listed('README.md')]], [[listed('docs/verified.json')], []]]) {
    expect(classify(files, event(2), 'pull_request')).toBe(true);
  }
  expect(classify([[listed('docs/verified.json'), listed('README.md')]], event(2), 'pull_request')).toBe(true);
  for (const name of ['', 'push', 'workflow_dispatch', 'merge_group', 'pull_request_target']) {
    expect(classify(valid, event(1), name)).toBe(true);
  }
});

test('real aggregate CLI fails missing decision and malformed needs and succeeds planned skips', () => {
  const script = new URL('../scripts/ci-scope.ts', import.meta.url).pathname;
  const run = (needs?: string, os = 'ubuntu-latest') => Bun.spawnSync([process.execPath, script, 'aggregate'], {
    env: { ...process.env, CI_NEEDS: needs, CI_OS: os }, stdout: 'pipe', stderr: 'pipe',
  });
  const deferred = run(JSON.stringify({ ...needsValue('false'), decision: { result: 'success', outputs: { run_full: 'false', macos_deferred: 'true' } } }), 'macos-latest');
  expect(deferred.exitCode).toBe(1);
  expect(deferred.stderr.toString()).toContain('::error title=macOS deferred::');
  expect(run(JSON.stringify(needsValue('false'))).exitCode).toBe(0);
  for (const value of [undefined, '{bad', '{}', JSON.stringify({ ...needsValue('false'), test: { result: 'success' } })]) {
    const failed = run(value);
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr.toString()).toContain('rerun');
  }
});

test('workflow retains required names, conservative job conditions and install-free light checks', async () => {
  const workflow = Bun.YAML.parse(await Bun.file(new URL('../.github/workflows/check.yml', import.meta.url)).text()) as {
    on: Record<string, unknown>; jobs: Record<string, { name?: string; needs?: string | string[]; if?: string;
      'runs-on': string; 'timeout-minutes': number; strategy?: { matrix: { os: string[] } };
      permissions?: Record<string, string>; steps: { id?: string; uses?: string; name?: string; run?: string; if?: string;
        with?: Record<string, unknown>; env?: Record<string, string> }[] }>;
  };
  expect(JSON.stringify(workflow.on)).not.toMatch(/"paths(?:-ignore)?":/);
  expect(Object.keys(workflow.on)).toEqual(['push', 'pull_request', 'workflow_dispatch']);
  expect(workflow.on.pull_request).toEqual({ types: ['opened', 'synchronize', 'reopened', 'ready_for_review'] });
  expect(workflow.on.push).toEqual({ branches: ['main'] });
  const { decision, test: tests, measure, check } = workflow.jobs;
  const testsMac = workflow.jobs['test-macos']!;
  const measureMac = workflow.jobs['measure-macos']!;
  expect(decision!.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' });
  expect(decision!['timeout-minutes']).toBe(5);
  expect(decision!.steps[0]!.with).toEqual({ 'sparse-checkout': 'scripts/ci-scope.ts', 'sparse-checkout-cone-mode': false });
  expect(decision!.steps.some(step => step.run?.includes('git show HEAD:.bun-version'))).toBe(true);
  expect(decision!.steps.some(step => step.run?.includes('gh api --paginate --slurp'))).toBe(true);
  for (const job of [tests!, measure!]) {
    expect(job.needs).toBe('decision');
    expect(job.if).toBe("needs.decision.outputs.run_full != 'false'");
  }
  for (const job of [testsMac, measureMac]) {
    expect(job.needs).toBe('decision');
    expect(job.if).toBe("needs.decision.outputs.run_full != 'false' && needs.decision.outputs.macos_deferred != 'true'");
  }
  type Matrix = { os: string[]; shard?: number[]; total?: number[] };
  expect(tests!.strategy!.matrix as Matrix).toEqual({ os: ['ubuntu-latest'], shard: [1, 2, 3, 4], total: [4] });
  expect(testsMac.strategy!.matrix as Matrix).toEqual({ os: ['macos-latest'], shard: [1, 2], total: [2] });
  expect(measure!.strategy!.matrix.os).toEqual(['ubuntu-latest']);
  expect(measureMac.strategy!.matrix.os).toEqual(['macos-latest']);
  expect(testsMac.steps).toEqual(tests!.steps);
  expect(measureMac.steps).toEqual(measure!.steps);
  expect(decision!.steps.find(step => step.id === 'draft')?.run).toBe('bun scripts/ci-scope.ts draft "$GITHUB_EVENT_PATH" >> "$GITHUB_OUTPUT"');
  expect(check!.name).toBeUndefined();
  expect(check!.strategy!.matrix.os).toEqual(['ubuntu-latest', 'macos-latest']);
  expect(check!.needs).toEqual(['decision', 'test', 'test-macos', 'measure', 'measure-macos']);
  expect(check!.if).toBe('always()');
  expect(check!.steps.find(step => step.run === 'bun scripts/ci-scope.ts aggregate')?.env).toEqual({ CI_NEEDS: '${{ toJSON(needs) }}', CI_OS: '${{ matrix.os }}' });
  for (const command of ['bun scripts/check-docs.ts', 'bun scripts/readme-facts.ts']) {
    expect(check!.steps.find(step => step.run === command)?.if).toBe("needs.decision.outputs.run_full == 'false'");
  }
  expect(check!.steps.some(step => step.run?.includes('--unshallow origin'))).toBe(true);
  expect(JSON.stringify(check!.steps)).not.toContain('bun install');
  const bunPin = measure!.steps.find(step => step.uses?.startsWith('oven-sh/setup-bun@'))!.uses;
  expect(decision!.steps.find(step => step.uses?.startsWith('oven-sh/setup-bun@'))?.uses).toBe(bunPin);
  expect(check!.steps.find(step => step.uses?.startsWith('oven-sh/setup-bun@'))?.uses).toBe(bunPin);
  const script = await Bun.file(new URL('../scripts/ci-scope.ts', import.meta.url)).text();
  for (const match of script.matchAll(/from ['"]([^'"]+)['"]/g)) expect(match[1]?.startsWith('node:')).toBe(true);
  expect(script).not.toMatch(/\bBun\./);
});
