import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregate, ALLOWLIST, classify, completeMatrix, draftDeferred, findTreeProof, fullProof, MACOS_DEFERRED_ERROR, main, recordedTree, reuseOutputs, workflowShards, type GitHubRead } from '../scripts/ci-scope.ts';

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
        with?: Record<string, unknown>; env?: Record<string, string>; 'continue-on-error'?: boolean }[] }>;
  };
  expect(JSON.stringify(workflow.on)).not.toMatch(/"paths(?:-ignore)?":/);
  expect(Object.keys(workflow.on)).toEqual(['push', 'pull_request', 'workflow_dispatch']);
  expect(workflow.on.pull_request).toEqual({ types: ['opened', 'synchronize', 'reopened', 'ready_for_review'] });
  expect(workflow.on.push).toEqual({ branches: ['main'] });
  const { decision, test: tests, measure, check } = workflow.jobs;
  const testsMac = workflow.jobs['test-macos']!;
  const measureMac = workflow.jobs['measure-macos']!;
  expect(decision!.permissions).toEqual({ contents: 'read', 'pull-requests': 'read', actions: 'read' });
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
  expect(testsMac.strategy!.matrix as Matrix).toEqual({ os: ['macos-latest'], shard: [1, 2, 3, 4], total: [4] });
  expect(measure!.strategy!.matrix.os).toEqual(['ubuntu-latest']);
  expect(measureMac.strategy!.matrix.os).toEqual(['macos-latest']);
  expect(testsMac.steps).toEqual(tests!.steps);
  expect(measureMac.steps).toEqual(measure!.steps);
  const advisory = ['measure-hooks-budget.ts', 'measure-hook-baseline.ts', 'measure-transcript-budget.ts',
    'measure-hook-stages.ts', 'measure-budget.ts', 'measure-mcp-budget.ts', 'measure-shard-ac8.ts'];
  for (const name of advisory) {
    const step = measure!.steps.find(item => item.run?.includes(name));
    expect(step?.['continue-on-error']).toBe(true);
  }
  for (const command of ['bun x tsc --noEmit', 'bun scripts/check-boundary.ts', 'bun scripts/readme-facts.ts',
    'bun scripts/check-docs.ts', 'npm pack --dry-run', 'bun scripts/smoke-installed-package.ts', 'test/previous-release.test.ts']) {
    const step = measure!.steps.find(item => item.run?.includes(command));
    expect(step).toBeDefined();
    expect(step?.['continue-on-error']).not.toBe(true);
  }
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

describe('#503 identical-tree main push reuse', () => {
  const REPO = 'STAIxBWLB/agent-mem', PUSHED = 'a'.repeat(40), HEAD = 'b'.repeat(40), TREE = 'c'.repeat(40), OTHER = 'd'.repeat(40);
  const SHARDS = { test: 4, 'test-macos': 4 };
  const ok = (name: string) => ({ name, status: 'completed', conclusion: 'success' });
  const heavyJobs = (n = 4, m = 4) => [...Array.from({ length: n }, (_, s) => ok(`test (ubuntu-latest, ${s + 1}, ${n})`)), ...Array.from({ length: m }, (_, s) => ok(`test-macos (macos-latest, ${s + 1}, ${m})`)),
    ok('measure (ubuntu-latest)'), ok('measure-macos (macos-latest)')];
  const fullJobs = (tree = TREE) => [ok('decision'), ok(`checkout-tree ${tree}`), ...heavyJobs(), ok('check (ubuntu-latest)'), ok('check (macos-latest)')];
  const skipped = (name: string) => ({ name, status: 'completed', conclusion: 'skipped' });
  const run = (id: number, extra: Record<string, unknown> = {}) => ({ id, head_sha: HEAD, event: 'pull_request', status: 'completed', conclusion: 'success',
    path: '.github/workflows/check.yml', head_repository: { full_name: REPO }, ...extra });
  type World = { pulls?: unknown; runs?: unknown[]; jobs?: Record<number, unknown[]>; fail?: RegExp };
  const api = (world: World): GitHubRead => async path => {
    if (world.fail?.test(path)) throw new Error('GitHub API 502');
    if (path === `repos/${REPO}/git/commits/${PUSHED}`) return { sha: PUSHED, tree: { sha: TREE } };
    if (path === `repos/${REPO}/commits/${PUSHED}/pulls`) return world.pulls ?? [{ number: 7, merged_at: '2026-11-20T00:00:00Z', base: { ref: 'main' }, head: { sha: HEAD, repo: { full_name: REPO } } }];
    if (path.startsWith(`repos/${REPO}/actions/workflows/check.yml/runs?`)) return { workflow_runs: world.runs ?? [run(41)] };
    const jobs = /actions\/runs\/(\d+)\/jobs/.exec(path);
    if (jobs) { const list = world.jobs?.[Number(jobs[1])] ?? fullJobs(); return { total_count: list.length, jobs: list }; }
    throw new Error(`unexpected ${path}`);
  };
  const find = (world: World, expected: typeof SHARDS | null = SHARDS) => findTreeProof(api(world), { repository: REPO, sha: PUSHED, expected });

  test('the declared workflow matrix is read from check.yml and fails closed when it is not plain', async () => {
    const workflow = await Bun.file(new URL('../.github/workflows/check.yml', import.meta.url)).text();
    expect(workflowShards(workflow)).toEqual(SHARDS);
    for (const broken of [workflow.replace('shard: [1, 2, 3, 4]', 'shard: [1, 2, 4]'), workflow.replace(/total: \[4\]/, 'total: [5]'), 'jobs: {}'])
      expect(workflowShards(broken)).toBeNull();
  });

  test('a full green PR check whose recorded checkout tree equals the pushed tree is proof', async () => {
    expect(fullProof(fullJobs(), SHARDS)).toBe(true);
    expect(recordedTree(fullJobs())).toBe(TREE);
    expect(await find({})).toEqual({ runId: 41, headSha: HEAD, pr: 7 });
    const env = { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: REPO, GITHUB_SHA: PUSHED };
    const workflow = await Bun.file(new URL('../.github/workflows/check.yml', import.meta.url)).text();
    expect(await reuseOutputs(api({}), env, workflow)).toEqual(['run_full=false', 'reused_run=41', `reused_head=${HEAD}`]);
    expect(await reuseOutputs(api({}), env, 'jobs: {}')).toEqual(['run_full=true', 'reused_run=', 'reused_head=']);
  });

  test('the run must prove its own checkout tree: a different, missing, duplicated or failed tree record is never proof', async () => {
    // e.g. the PR's head (or its live association) changed after the run: the run's own record still names what it tested.
    for (const jobs of [fullJobs(OTHER), fullJobs().filter(job => !job.name.startsWith('checkout-tree')), [...fullJobs(), ok(`checkout-tree ${TREE}`)],
      fullJobs().map(job => job.name.startsWith('checkout-tree') ? { ...job, conclusion: 'failure' } : job), fullJobs().map(job => job.name.startsWith('checkout-tree') ? { ...job, name: 'checkout-tree ' } : job)])
      expect(await find({ jobs: { 41: jobs } })).toBeNull();
  });

  test('draft-deferred, scope-reduced, missing, failed and wrong-matrix runs are never proof', async () => {
    const replaceHeavy = (heavy: { name: string }[]) => [ok('decision'), ok(`checkout-tree ${TREE}`), ...heavy, ok('check (ubuntu-latest)'), ok('check (macos-latest)')];
    const draftDeferredRun = replaceHeavy([...heavyJobs().filter(job => !job.name.startsWith('test-macos') && !job.name.startsWith('measure-macos')),
      ...[1, 2, 3, 4].map(s => skipped(`test-macos (macos-latest, ${s}, 4)`)), skipped('measure-macos (macos-latest)')]);
    const scopeReduced = replaceHeavy(heavyJobs().map(job => skipped(job.name)));
    const cases = [draftDeferredRun, scopeReduced,
      fullJobs().filter(job => job.name !== 'measure (ubuntu-latest)'), fullJobs().filter(job => job.name !== 'test (ubuntu-latest, 3, 4)'),
      fullJobs().map(job => job.name === 'test (ubuntu-latest, 3, 4)' ? { ...job, conclusion: 'failure' } : job),
      fullJobs().map(job => job.name === 'check (macos-latest)' ? { ...job, conclusion: 'failure' } : job),
      [...fullJobs(), ok('check (ubuntu-latest)')], [...fullJobs(), ok('test (ubuntu-latest, 2, 4)')], [...fullJobs(), ok('measure (ubuntu-latest)')],
      replaceHeavy(heavyJobs(1, 1)), replaceHeavy(heavyJobs(2, 4)), replaceHeavy(heavyJobs(4, 3)), [...fullJobs(), ok('test (macos-latest, 1, 4)')], []];
    for (const jobs of cases) {
      expect(fullProof(jobs, SHARDS)).toBe(false);
      expect(await find({ jobs: { 41: jobs } })).toBeNull();
    }
    // A coherent smaller matrix is proof only when the pushed workflow declares exactly that matrix.
    expect(fullProof(replaceHeavy(heavyJobs(1, 1)), { test: 1, 'test-macos': 1 })).toBe(true);
    expect(completeMatrix(heavyJobs(1, 1).map(job => job.name), SHARDS)).toBe(false);
    expect(await find({}, null)).toBeNull();
    expect(fullProof([{ name: 7 }], SHARDS)).toBe(false);
    expect(fullProof('jobs', SHARDS)).toBe(false);
  });

  test('API errors, ambiguity and foreign evidence all run everything', async () => {
    for (const fail of [/git\/commits/, /\/pulls$/, /workflows/, /jobs/]) expect(await find({ fail })).toBeNull();
    const pr = (n: number, repo = REPO) => ({ number: n, merged_at: '2026-11-20T00:00:00Z', base: { ref: 'main' }, head: { sha: HEAD, repo: { full_name: repo } } });
    for (const pulls of [[], [pr(7), pr(8)], [pr(7, 'someone/fork')], [{ ...pr(7), merged_at: null }], 'not a list']) expect(await find({ pulls })).toBeNull();
    for (const runs of [[], [run(41, { event: 'push' })], [run(41, { conclusion: 'failure' })], [run(41, { head_sha: PUSHED })],
      [run(41, { path: '.github/workflows/release.yml' })], [run(41, { head_repository: { full_name: 'someone/fork' } })]]) expect(await find({ runs })).toBeNull();
    const partial: GitHubRead = async path => /jobs/.test(path) ? { total_count: 99, jobs: fullJobs() } : api({})(path);
    expect(await findTreeProof(partial, { repository: REPO, sha: PUSHED, expected: SHARDS })).toBeNull();
    expect(await find({ runs: [run(40), run(41)], jobs: { 40: fullJobs().slice(0, 3) } })).toEqual({ runId: 41, headSha: HEAD, pr: 7 });
    expect(await findTreeProof(api({}), { repository: REPO, sha: 'short', expected: SHARDS })).toBeNull();
  });

  test('only a push to main can reuse; pull requests and dispatch keep their full runs', async () => {
    const workflow = await Bun.file(new URL('../.github/workflows/check.yml', import.meta.url)).text();
    const base = { GITHUB_REPOSITORY: REPO, GITHUB_SHA: PUSHED };
    for (const env of [{ ...base, GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/heads/main' }, { ...base, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main' },
      { ...base, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/other' }])
      expect(await reuseOutputs(api({}), env, workflow)).toEqual(['run_full=true', 'reused_run=', 'reused_head=']);
    expect(await reuseOutputs(api({ fail: /pulls/ }), { ...base, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main' }, workflow)).toEqual(['run_full=true', 'reused_run=', 'reused_head=']);
  });

  test('a reused main run passes both aggregates only when every heavy job was skipped', () => {
    const needs = (heavy: string) => ({ decision: { result: 'success', outputs: { run_full: 'false', macos_deferred: 'false', reused_run: '41' } },
      test: { result: heavy }, measure: { result: heavy }, 'test-macos': { result: heavy }, 'measure-macos': { result: heavy } });
    for (const os of ['ubuntu-latest', 'macos-latest']) { expect(aggregate(needs('skipped'), os)).toEqual([]); expect(aggregate(needs('success'), os)).not.toEqual([]); }
  });

  test('the workflow records each run tree in a job name, reuses only on push and names the reused run', async () => {
    const workflow = Bun.YAML.parse(await Bun.file(new URL('../.github/workflows/check.yml', import.meta.url)).text()) as { jobs: Record<string, { name?: string; needs?: string; permissions?: unknown; outputs?: Record<string, string>; steps: { id?: string; run?: string; if?: string; env?: Record<string, string> }[] }> };
    const decision = workflow.jobs.decision!;
    expect(decision.steps.find(step => step.id === 'tree')?.run).toBe(`echo "tree=$(git rev-parse 'HEAD^{tree}')" >> "$GITHUB_OUTPUT"`);
    expect(decision.outputs).toMatchObject({ tree: '${{ steps.tree.outputs.tree }}', reused_run: '${{ steps.scope.outputs.reused_run }}', reused_head: '${{ steps.scope.outputs.reused_head }}' });
    expect(workflow.jobs['checkout-tree']).toMatchObject({ name: 'checkout-tree ${{ needs.decision.outputs.tree }}', needs: 'decision', permissions: {} });
    expect(decision.steps.find(step => step.id === 'scope')!.run).toContain('if [ "$GITHUB_EVENT_NAME" = push ]; then\n  bun scripts/ci-scope.ts reuse <(git show HEAD:.github/workflows/check.yml) >> "$GITHUB_OUTPUT"');
    const summary = workflow.jobs.check!.steps.find(step => step.if === "needs.decision.outputs.reused_run != ''")!;
    expect(summary.run).toContain('GITHUB_STEP_SUMMARY');
    expect(summary.env).toEqual({ REUSED_RUN: '${{ needs.decision.outputs.reused_run }}', REUSED_HEAD: '${{ needs.decision.outputs.reused_head }}' });
  });
});
