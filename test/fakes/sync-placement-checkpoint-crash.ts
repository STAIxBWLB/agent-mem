import { acquireMutation } from "../../src/memory/mutation.ts";
import { applyPlacementCheckpoint, planPlacementCheckpoint, resumePlacementCheckpoint, type PlacementCheckpointInput, type PlacementCheckpointPhase } from "../../src/memory/sync-placement-checkpoint.ts";

const [home, epoch, rawInput, wanted, rawOrdinal] = process.argv.slice(2);
if (!home || !epoch || !rawInput || !wanted || !rawOrdinal) throw Error("checkpoint crash fixture arguments missing");
const input = JSON.parse(rawInput) as PlacementCheckpointInput;
const plan = wanted === "commit-prefix" ? undefined : planPlacementCheckpoint(home, epoch, input);
const mutation = acquireMutation(home);
if (!mutation) throw Error("checkpoint crash fixture mutation unavailable");
if (wanted === "commit-prefix") {
  resumePlacementCheckpoint(home, epoch, { mutation, assertCurrent() {}, commitPrefix(bytes) {
    if (bytes === Number(rawOrdinal)) {
      process.stdout.write(`commit-prefix:${bytes}\n`);
      process.kill(process.pid, "SIGKILL");
    }
  } });
  throw Error("checkpoint crash fixture did not reach requested prefix");
}
let seen = 0;
applyPlacementCheckpoint(home, plan!, input, { mutation, assertCurrent() {}, phase(phase: PlacementCheckpointPhase) {
  if (phase === wanted && ++seen === Number(rawOrdinal)) {
    process.stdout.write(`${phase}:${seen}\n`);
    process.kill(process.pid, "SIGKILL");
  }
} });
throw Error("checkpoint crash fixture did not reach requested phase");
