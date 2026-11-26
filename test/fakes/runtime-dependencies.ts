import { copyFileSync, cpSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Copy only the pinned runtime source into a fake install's nested node_modules. */
export function installRuntimeFixtures(installRoot: string): void {
  const dependencies = [
    ["@staix/cli-output", "0.1.3", import.meta.resolve("@staix/cli-output")],
    ["@staix/mcp-stdio", "0.2.0", import.meta.resolve("@staix/mcp-stdio")],
  ] as const;
  for (const [name, version, entry] of dependencies) {
    const packageRoot = dirname(dirname(fileURLToPath(entry)));
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { name?: string; version?: string };
    if (manifest.name !== name || manifest.version !== version) throw new Error(`fixture requires the pinned ${name} ${version} package`);
    const target = join(installRoot, "node_modules", name);
    mkdirSync(target, { recursive: true, mode: 0o755 });
    copyFileSync(join(packageRoot, "package.json"), join(target, "package.json"));
    cpSync(join(packageRoot, "src"), join(target, "src"), { recursive: true });
  }
}
