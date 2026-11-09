/**
 * #331: true when an `EXPLAIN QUERY PLAN` result is the bounded `Record` seek `countOutsideRecent` requires, meaning the
 * derived index is searched with the project and an upper `at` bound, with no table scan and no temporary sort.
 * It lives outside `capture.ts` only so `src/index.ts`'s capture re-export does not carry it; the store method and its
 * result type stay the root surface. Its own test covers a bundled SQLite that renders the seek differently.
 */
export function outsideCountPlanIsBounded(plan: readonly { detail: string }[]): boolean {
  return plan.some(row => /^SEARCH rows USING INDEX rows_brief_records_v1 \(project=\?[^)]*at<\?/.test(row.detail))
    && !plan.some(row => /^SCAN rows\b/.test(row.detail) || row.detail.includes("TEMP B-TREE"));
}
