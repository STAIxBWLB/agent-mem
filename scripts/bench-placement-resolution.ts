/** #654: compare warm per-call wall time on one disposable placement home.
 * bun scripts/bench-placement-resolution.ts <baseline checkout> [projects=115] [iterations=500]
 */
import { join, resolve } from "node:path";
import { createPlacementInspectionFixture, inspectionNote } from "../test/fakes/sync-placement-inspection.ts";
import * as current from "../src/memory/shard.ts";

const [baseline, projectsArg = "115", iterationsArg = "500"] = process.argv.slice(2);
const projects = Number(projectsArg);
const iterations = Number(iterationsArg);
if (!baseline || !Number.isSafeInteger(projects) || projects < 1 || projects > 255 || !Number.isSafeInteger(iterations) || iterations < 1) {
  throw new Error("usage: bench-placement-resolution.ts <baseline checkout> [projects=115] [iterations=500]");
}
const before = await import(join(resolve(baseline), "src", "memory", "shard.ts")) as typeof current;
const fixture = await createPlacementInspectionFixture({
  seed(store, project) {
    for (let index = 0; index < projects; index++) {
      store.note(inspectionNote("Synthetic placement benchmark note", index === 0 ? project : `example.test/placement/project-${index}`));
    }
    return {};
  },
});
try {
  const result = { projects, iterations, before: measure(before), after: measure(current) };
  console.log(JSON.stringify(result, null, 2));
} finally {
  fixture.close();
}

function measure(api: typeof current) {
  return {
    selectionUs: run(() => api.readShardedSelection(fixture.home)),
    resolutionUs: run(() => api.resolveShardProfile(fixture.home, { project: fixture.project })),
  };
}

function run(call: () => unknown): number {
  for (let index = 0; index < 30; index++) call();
  const samples = [];
  for (let sample = 0; sample < 5; sample++) {
    const start = performance.now();
    for (let index = 0; index < iterations; index++) call();
    samples.push((performance.now() - start) * 1000 / iterations);
  }
  return Number(samples.sort((a, b) => a - b)[2]!.toFixed(1));
}
