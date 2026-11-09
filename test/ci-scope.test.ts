import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregate, ALLOWLIST, classify, main } from '../scripts/ci-scope.ts';

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
    decision: { result: 'success', outputs: { run_full } },
    test: { result: testResult }, measure: { result: measureResult },
  });
  test('accepts only the planned success/skip combinations', () => {
    expect(aggregate(needs('true', 'success'))).toEqual([]);
    expect(aggregate(needs('false', 'skipped'))).toEqual([]);
    for (const bad of [
      needs('true', 'skipped'), needs('false', 'success'), needs('false', 'cancelled'),
      needs('true', 'failure'), needs('false', 'success', 'skipped'),
      { ...needs('false', 'skipped'), decision: { result: 'failure', outputs: { run_full: 'false' } } },
      { ...needs('false', 'skipped'), decision: { result: 'success', outputs: {} } },
      { ...needs('false', 'skipped'), measure: undefined },
      needs('maybe', 'skipped'),
    ]) expect(aggregate(bad).length).toBeGreaterThan(0);
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
    expect(await main(['aggregate'], { CI_NEEDS: JSON.stringify(needsValue('false')) })).toBe(0);
    expect(await main(['aggregate'], { CI_NEEDS: '{bad' })).toBe(1);
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
  return { decision: { result: 'success', outputs: { run_full } }, test: { result: 'skipped' }, measure: { result: 'skipped' } };
}

// The aggregate is a required status check: every unplanned result must fail, in either direction.
test('aggregate rejects every result combination except the two planned matrices', () => {
  const results = ['success', 'skipped', 'failure', 'cancelled', undefined];
  for (const decisionResult of results) for (const runFull of ['true', 'false', 'invalid', undefined]) {
    for (const testResult of results) for (const measureResult of results) {
      const needs = { decision: { result: decisionResult, outputs: { run_full: runFull } },
        test: { result: testResult }, measure: { result: measureResult } };
      const expected = decisionResult === 'success' && (
        runFull === 'true' && testResult === 'success' && measureResult === 'success'
        || runFull === 'false' && testResult === 'skipped' && measureResult === 'skipped');
      expect(aggregate(needs).length === 0).toBe(expected);
    }
  }
  expect(aggregate({ decision: { result: 'success', outputs: { run_full: 'true' } },
    test: { result: 'skipped' }, measure: { result: 'success' } })[0]).toContain('test result=skipped decision=true');
  expect(aggregate(undefined)[0]).toContain('inspect the job and rerun');
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
  const run = (needs?: string) => Bun.spawnSync([process.execPath, script, 'aggregate'], {
    env: { ...process.env, CI_NEEDS: needs }, stdout: 'pipe', stderr: 'pipe',
  });
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
      permissions?: Record<string, string>; steps: { uses?: string; name?: string; run?: string; if?: string;
        with?: Record<string, unknown>; env?: Record<string, string> }[] }>;
  };
  expect(JSON.stringify(workflow.on)).not.toMatch(/"paths(?:-ignore)?":/);
  expect(Object.keys(workflow.on)).toEqual(['push', 'pull_request', 'workflow_dispatch']);
  const { decision, test: tests, measure, check } = workflow.jobs;
  expect(decision!.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' });
  expect(decision!['timeout-minutes']).toBe(5);
  expect(decision!.steps[0]!.with).toEqual({ 'sparse-checkout': 'scripts/ci-scope.ts', 'sparse-checkout-cone-mode': false });
  expect(decision!.steps.some(step => step.run?.includes('git show HEAD:.bun-version'))).toBe(true);
  expect(decision!.steps.some(step => step.run?.includes('gh api --paginate --slurp'))).toBe(true);
  for (const job of [tests!, measure!]) {
    expect(job.needs).toBe('decision');
    expect(job.if).toBe("needs.decision.outputs.run_full != 'false'");
  }
  expect(check!.name).toBeUndefined();
  expect(check!.strategy!.matrix.os).toEqual(['ubuntu-latest', 'macos-latest']);
  expect(check!.needs).toEqual(['decision', 'test', 'measure']);
  expect(check!.if).toBe('always()');
  expect(check!.steps.find(step => step.run === 'bun scripts/ci-scope.ts aggregate')?.env?.CI_NEEDS).toBe('${{ toJSON(needs) }}');
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
