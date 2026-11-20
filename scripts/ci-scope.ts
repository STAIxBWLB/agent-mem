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

// #503: a main push may skip its heavy jobs only when a pull_request `check` run already passed on an identical tree.
export interface ProofJob { name?: unknown; status?: unknown; conclusion?: unknown }
const HEAVY = /^(test|test-macos|measure|measure-macos) \(/;
const HEAVY_KINDS = ['test (ubuntu-latest', 'test-macos (macos-latest', 'measure (ubuntu-latest', 'measure-macos (macos-latest'];
/** A full proof ran every heavy kind on both OSes and every job passed; a draft-deferred (macOS skipped) or scope-reduced (tests skipped) run never is. */
export function fullProof(jobs: unknown): boolean {
  if (!Array.isArray(jobs) || jobs.length === 0) return false;
  const rows = jobs.map(job => record(job) as ProofJob | undefined);
  if (rows.some(job => typeof job?.name !== 'string')) return false;
  const named = rows as { name: string; status?: unknown; conclusion?: unknown }[];
  const passed = (job: { status?: unknown; conclusion?: unknown }) => job.status === 'completed' && job.conclusion === 'success';
  const heavy = named.filter(job => HEAVY.test(job.name));
  if (!HEAVY_KINDS.every(kind => heavy.some(job => job.name.startsWith(kind)))) return false;
  if (!heavy.every(passed)) return false;
  return ['check (ubuntu-latest)', 'check (macos-latest)'].every(name => {
    const matches = named.filter(job => job.name === name);
    return matches.length === 1 && passed(matches[0]!);
  });
}

export type GitHubRead = (path: string) => Promise<unknown>;
export interface TreeProof { runId: number; headSha: string; pr: number }
const SHA = /^[a-f0-9]{40}$/;
/** Find the merged PR whose head tree equals the pushed tree and a full successful PR check at that head. Any error or ambiguity is null: run everything. */
export async function findTreeProof(api: GitHubRead, input: { repository: string; sha: string }): Promise<TreeProof | null> {
  try {
    const { repository, sha } = input;
    if (!SHA.test(sha) || !/^[\w.-]+\/[\w.-]+$/.test(repository)) return null;
    const treeOf = async (commit: string) => {
      const value = record(await api(`repos/${repository}/git/commits/${commit}`));
      const tree = record(value?.tree)?.sha;
      return value?.sha === commit && typeof tree === 'string' && SHA.test(tree) ? tree : undefined;
    };
    const pushed = await treeOf(sha);
    if (!pushed) return null;
    const pulls = await api(`repos/${repository}/commits/${sha}/pulls`);
    if (!Array.isArray(pulls)) return null;
    const merged = pulls.map(record).filter(pr => typeof pr?.merged_at === 'string' && record(pr.base)?.ref === 'main');
    if (merged.length !== 1) return null;
    const pr = merged[0]!, head = record(pr.head), headSha = head?.sha;
    if (typeof pr.number !== 'number' || typeof headSha !== 'string' || !SHA.test(headSha)) return null;
    if (record(head?.repo)?.full_name !== repository) return null; // fork heads are never proof
    if (await treeOf(headSha) !== pushed) return null;
    const listed = record(await api(`repos/${repository}/actions/workflows/check.yml/runs?event=pull_request&head_sha=${headSha}&status=success&per_page=100`));
    const runs = Array.isArray(listed?.workflow_runs) ? listed.workflow_runs.map(record) : undefined;
    if (!runs) return null;
    for (const run of runs) {
      if (typeof run?.id !== 'number' || run.head_sha !== headSha || run.event !== 'pull_request' || run.status !== 'completed' || run.conclusion !== 'success'
        || run.path !== '.github/workflows/check.yml' || record(run.head_repository)?.full_name !== repository) continue;
      const jobs = record(await api(`repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`));
      if (!Array.isArray(jobs?.jobs) || jobs.total_count !== jobs.jobs.length) continue; // an incomplete job read is never proof
      if (fullProof(jobs.jobs)) return { runId: run.id, headSha, pr: pr.number };
    }
    return null;
  } catch {
    return null;
  }
}

export function githubRead(token: string | undefined, fetcher: typeof fetch = fetch): GitHubRead {
  return async path => {
    const response = await fetcher(`https://api.github.com/${path}`, { headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`GitHub API ${response.status}`);
    return await response.json() as unknown;
  };
}

/** Decision outputs for a push event: reused proof skips the heavy jobs; anything else runs everything. */
export async function reuseOutputs(api: GitHubRead, env: NodeJS.ProcessEnv): Promise<string[]> {
  if (env.GITHUB_EVENT_NAME !== 'push' || env.GITHUB_REF !== 'refs/heads/main') return ['run_full=true', 'reused_run=', 'reused_head='];
  const proof = await findTreeProof(api, { repository: env.GITHUB_REPOSITORY ?? '', sha: env.GITHUB_SHA ?? '' });
  return proof ? ['run_full=false', `reused_run=${proof.runId}`, `reused_head=${proof.headSha}`] : ['run_full=true', 'reused_run=', 'reused_head='];
}

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
  if (args[0] === 'reuse' && args.length === 1) {
    let lines = ['run_full=true', 'reused_run=', 'reused_head='];
    try { lines = await reuseOutputs(githubRead(env.GH_TOKEN), env); } catch { /* run everything */ }
    for (const line of lines) console.log(line);
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
  console.error('Usage: ci-scope.ts classify <files.json> <event.json> | draft <event.json> | reuse (main push; GH_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA) | aggregate (set CI_NEEDS to toJSON(needs) and CI_OS to the matrix os)');
  return 1;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env);
