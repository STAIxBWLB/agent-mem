import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Copy only the pinned dependency's runtime files into a fake install's nested node_modules. */
export function installCliOutputFixture(installRoot: string): void {
  const entry = fileURLToPath(import.meta.resolve("@staix/cli-output")), packageRoot = dirname(dirname(entry));
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { name?: string; version?: string };
  if (manifest.name !== "@staix/cli-output" || manifest.version !== "0.1.3") throw new Error("fixture requires the pinned cli-output 0.1.3 package");
  const target = join(installRoot, "node_modules", "@staix", "cli-output");
  mkdirSync(join(target, "src"), { recursive: true, mode: 0o755 });
  copyFileSync(join(packageRoot, "package.json"), join(target, "package.json"));
  copyFileSync(entry, join(target, "src", "index.ts"));
}
