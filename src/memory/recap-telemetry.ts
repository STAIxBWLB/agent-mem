/** Observation journals are not inputs to Recap or its reusable panel projections. */
export function isRecapTelemetry(name: string): boolean {
  return name === "metrics.jsonl" || name === "record-variants.jsonl"
    || /^record-variants\.jsonl\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(name);
}
