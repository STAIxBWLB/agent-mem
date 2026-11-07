export type ReadAPI = (path: string) => Promise<unknown>;
export class ReleaseProofError extends Error { kind: string; constructor(kind: string, cause: string); }
export function frozenTag(api: ReadAPI, tag: string, commit: string, expectedObject?: string): Promise<string>;
export interface ReleaseInput { repository: string; commit: string; tag?: string; tagObject?: string }
export interface ReleaseProof { commit: string; tree: string; tagObject?: string; runId: number; runCommit: string; runAttempt: number; url: string; requests: number }
export function proveRelease(api: ReadAPI, input: ReleaseInput, options?: { now?: () => number; sleep?: (ms: number) => Promise<void>; waitMs?: number; pollMs?: number }): Promise<ReleaseProof>;
export function githubReader(repository: string, token: string, options?: { fetcher?: typeof fetch; deadline?: number }): ReadAPI;
