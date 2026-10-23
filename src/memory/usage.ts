import { readCatalogFresh, type CatalogProject } from "./catalog.ts";

/**
 * #15 T5 / D3: `amem usage`. Totals and the largest shards, derived from the shards through the catalog scan (never a number of its own). A forgotten
 * project is out of the default view and the totals; `includeForgotten` shows it. A curated count the catalog could not read is `null`, never zero.
 */
export interface UsageTotals { shards: number; captureRows: number; captureBytes: number; curatedEntries: number | null; diskBytes: number }
export interface UsageReport { projects: CatalogProject[]; totals: UsageTotals; largest: CatalogProject[] }

export function usageReport(base: string, opts: { limit?: number; includeForgotten?: boolean } = {}): UsageReport {
  const limit = opts.limit ?? 5;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("--limit takes a number from 1 to 100");
  const projects = readCatalogFresh(base).filter(project => opts.includeForgotten === true || project.state !== "forgotten");
  const curated = projects.every(project => project.curatedEntries !== null) ? projects.reduce((sum, project) => sum + (project.curatedEntries ?? 0), 0) : null;
  const totals: UsageTotals = { shards: projects.length, captureRows: projects.reduce((s, p) => s + p.captureRows, 0), captureBytes: projects.reduce((s, p) => s + p.captureBytes, 0),
    curatedEntries: curated, diskBytes: projects.reduce((s, p) => s + p.diskBytes, 0) };
  const largest = [...projects].sort((a, b) => b.diskBytes - a.diskBytes || b.captureBytes - a.captureBytes || a.key.localeCompare(b.key)).slice(0, limit);
  return { projects, totals, largest };
}

const MB = 1048576;
const mb = (n: number): string => `${(n / MB).toFixed(1)} MB`;

/** The non-JSON rendering of `amem usage`. */
export function usageText(report: UsageReport): string {
  const t = report.totals;
  return [
    `${t.shards} project shard(s): ${t.captureRows} capture rows (${mb(t.captureBytes)}), ${t.curatedEntries === null ? "curated count unavailable" : `${t.curatedEntries} curated entries`}, ${mb(t.diskBytes)} on disk`,
    ...(report.largest.length ? ["largest:", ...report.largest.map(p => `  ${mb(p.diskBytes).padStart(10)}  ${p.key}${p.state === "active" ? "" : ` (${p.state})`}  ${p.captureRows} rows`)] : []),
  ].join("\n");
}
