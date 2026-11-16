import { readFile } from 'node:fs/promises';

export const ALLOWLIST: readonly string[] = Object.freeze(['docs/verified.json']);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function classify(files: unknown, event: unknown, eventName: string): boolean {
  if (eventName !== 'pull_request') return true;
  const eventObject = record(event);
  const pullRequest = record(eventObject?.pull_request);
  const count = pullRequest?.changed_files;
  if (!Number.isSafeInteger(count) || (count as number) <= 0 || (count as number) >= 3000) return true;
  if (!Array.isArray(files) || files.length === 0) return true;
  const seen = new Set<string>();
  for (const page of files) {
    if (!Array.isArray(page) || page.length === 0) return true;
    for (const item of page) {
      const file = record(item);
      if (typeof file?.filename !== 'string' || file.filename.length === 0) return true;
      if (seen.has(file.filename)) return true;
      seen.add(file.filename);
      if (!ALLOWLIST.includes(file.filename)) return true;
      if (file.status === 'renamed' && file.previous_filename === undefined) return true;
      if (file.previous_filename !== undefined) {
        if (typeof file.previous_filename !== 'string' || !ALLOWLIST.includes(file.previous_filename)) return true;
      }
    }
  }
  return seen.size !== count;
}

// Only an explicit `draft: true` defers macOS; an unknown flag means a full run.
export function draftDeferred(event: unknown, eventName: string): boolean {
  if (eventName !== 'pull_request') return false;
  return record(record(event)?.pull_request)?.draft === true;
}

export const MACOS_DEFERRED_ERROR = '::error title=macOS deferred::draft PR; macOS runs when the PR is marked ready (gh pr ready)';

type Job = { result?: unknown; outputs?: Record<string, unknown> };
// `os` selects which jobs back the required check name: Ubuntu reads test/measure, macOS reads test-macos/measure-macos.
export function aggregate(needs: unknown, os: string): string[] {
  const jobs = record(needs);
  const decision = record(jobs?.decision) as Job | undefined;
  const macos = os === 'macos-latest';
  if (!macos && os !== 'ubuntu-latest') return [`unknown os=${os}; inspect the check matrix and rerun.`];
  const test = record(jobs?.[macos ? 'test-macos' : 'test']) as Job | undefined;
  const measure = record(jobs?.[macos ? 'measure-macos' : 'measure']) as Job | undefined;
  const runFull = decision?.outputs?.run_full;
  const deferred = decision?.outputs?.macos_deferred;
  const errors: string[] = [];
  // A deferred plan is never success: release evidence and the merge rule must not borrow a run without macOS.
  if (macos && deferred === 'true') {
    errors.push(MACOS_DEFERRED_ERROR);
    for (const [name, job] of [['test-macos', test], ['measure-macos', measure]] as const) {
      if (job?.result !== 'skipped') errors.push(`${name} result=${String(job?.result ?? 'missing')} while deferred; inspect that job and rerun.`);
    }
    return errors;
  }
  if (deferred !== 'true' && deferred !== 'false') {
    errors.push(`decision macos_deferred=${String(deferred ?? 'missing')}; inspect the job and rerun.`);
  }
  const describe = (name: string, job: Job | undefined) => `${name} result=${String(job?.result ?? 'missing')} decision=${String(runFull ?? 'missing')}`;
  if (decision?.result !== 'success' || (runFull !== 'true' && runFull !== 'false')) {
    errors.push(`${describe('decision', decision)}; inspect the job and rerun.`);
  }
  for (const [name, job] of [[macos ? 'test-macos' : 'test', test], [macos ? 'measure-macos' : 'measure', measure]] as const) {
    const expected = runFull === 'true' ? 'success' : runFull === 'false' ? 'skipped' : undefined;
    if (job?.result !== expected) errors.push(`${describe(name, job)}; inspect that job and rerun.`);
  }
  return errors;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

export async function main(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  if (args[0] === 'classify') {
    if (args.length !== 3) { console.log('run_full=true'); return 0; }
    try {
      const [files, event] = await Promise.all([readJson(args[1]!), readJson(args[2]!)]);
      const result = classify(files, event, env.GITHUB_EVENT_NAME ?? '');
      console.log(`run_full=${result}`);
    } catch {
      console.log('run_full=true');
    }
    return 0;
  }
  if (args[0] === 'draft') {
    let deferred = false;
    try {
      if (args.length === 2) deferred = draftDeferred(await readJson(args[1]!), env.GITHUB_EVENT_NAME ?? '');
    } catch { /* unreadable event: not a draft, full run */ }
    console.log(`macos_deferred=${deferred}`);
    return 0;
  }
  if (args[0] === 'aggregate' && args.length === 1) {
    try {
      if (!env.CI_NEEDS) throw new Error('CI_NEEDS is missing');
      const errors = aggregate(JSON.parse(env.CI_NEEDS) as unknown, env.CI_OS ?? '');
      for (const error of errors) console.error(error);
      return errors.length ? 1 : 0;
    } catch (error) {
      console.error(`aggregate inputs invalid (${error instanceof Error ? error.message : 'unknown error'}); inspect decision and rerun.`);
      return 1;
    }
  }
  console.error('Usage: ci-scope.ts classify <files.json> <event.json> | draft <event.json> | aggregate (set CI_NEEDS to toJSON(needs) and CI_OS to the matrix os)');
  return 1;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env);
