/** Closed, data-free diagnoses for explicit remote realm discovery and admission. */
export type RemoteRealmCause = "lock" | "pending" | "drift" | "remote" | "environment" | "cache" | "epoch" | "staging" | "bound" | "existing" | "other";
const messages: Record<RemoteRealmCause, string> = {
  lock: "Another sync or admission holds a lock; wait for it to finish, then retry.",
  pending: "Another realm has a retained admission; resume or abandon it with amem migrate --sync-placement --admit <project> --resume or --abandon before retrying.",
  drift: "Local sources, policy, aliases, writers or journal changed; finish pending sync work, then run amem migrate --sync-placement --admit <project> --from-remote --dry-run again.",
  remote: "The remote head moved, or the configured remote is unreachable or not private; check the remote, then run amem migrate --sync-placement --admit <project> --from-remote --dry-run again.",
  environment: "Git tracing is enabled and can write outside the cache; disable GIT_TRACE variables in this command's environment, then retry.",
  cache: "The local placement Git cache or its configuration is unsafe, missing or changed; stop sync and inspect the private placement cache before retrying.",
  epoch: "No valid active placement is available; review and activate placement with amem migrate --sync-placement --dry-run first.",
  staging: "Remote admission staging cannot be attributed or verified; retain it for inspection and see docs/purge.md.",
  bound: "The remote realm exceeds a supported bound; retain the evidence and run amem migrate --sync-placement --admit <project> --from-remote --dry-run to inspect the bound.",
  existing: "Existing curated state prevents remote admission; inspect the local realm with amem migrate --sync-placement --admit <project> --dry-run.",
  other: "Remote realm discovery or admission is unavailable; inspect the placement state and retry its --dry-run.",
};
export class RemoteRealmRefusal extends Error {
  constructor(readonly causeClass: RemoteRealmCause, subpath?: string) {
    const safeName = subpath && subpath.length <= 128 && !/[\r\n]/.test(subpath) && /^(?:log|local|legacy|legacy-main|generation\.json|generation-seal\.json|migration-sources\.json|machine\.json|prune-translations\.jsonl|prune-plans|public-prune-objects|public-prune-inputs|public-prune-input-sets|index(?:-v[0-9]+(?:-i[0-9]+)?)?\.db(?:-wal|-shm|-journal)?|search(?:-s[0-9]+)?\.db(?:-wal|-shm|-journal)?)$/.test(subpath) ? subpath : undefined;
    super(`Remote realm unavailable (${causeClass}): ${safeName ? `existing curated subpath: ${safeName}. ` : ""}${messages[causeClass]}`); this.name = "RemoteRealmRefusal";
  }
}
