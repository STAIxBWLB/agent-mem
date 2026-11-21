/** Print the current fingerprint for a human compatibility review; do not silently overwrite the v1 contract. */
import { join } from "node:path";
import ts from "typescript";
import { fingerprint } from "./fingerprint.ts";
import { rootValues, rootTypes, platformValues, platformTypes } from "./surface.ts";
const root = join(import.meta.dir, "../../..");
console.log(JSON.stringify({ typescriptVersion: ts.version, root: fingerprint(join(root, "src/index.ts"), rootValues, rootTypes), platform: fingerprint(join(root, "src/memory/platform.ts"), platformValues, platformTypes) }, null, 2));
