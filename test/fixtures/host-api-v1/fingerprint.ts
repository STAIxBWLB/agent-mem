import { join } from "node:path";
import ts from "typescript";
/** Freeze the host-visible callable signatures, class public members and types. Conservative fingerprints also flag
 * benign widening/additions for review; the fixture changes only after checking the v1 contract is still satisfied. */
export function fingerprint(file: string, values: readonly string[], types: readonly string[]): Record<string, unknown> {
  const config = ts.readConfigFile(join(import.meta.dir, "../../../tsconfig.json"), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, join(import.meta.dir, "../../.."));
  const program = ts.createProgram(parsed.fileNames, parsed.options), checker = program.getTypeChecker();
  const source = program.getSourceFile(file); if (!source) throw Error(`host API source not found: ${file}`);
  const module = checker.getSymbolAtLocation(source); if (!module) throw Error("host API module unavailable");
  const exports = new Map(checker.getExportsOfModule(module).map(symbol => [symbol.name, symbol]));
  const flags = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias | ts.TypeFormatFlags.UseStructuralFallback;
  const signature = (sig: ts.Signature) => checker.signatureToString(sig, undefined, flags);
  const describe = (type: ts.Type): unknown => ({
    type: checker.typeToString(type, undefined, flags),
    calls: type.getCallSignatures().map(signature),
    constructors: type.getConstructSignatures().map(signature),
  });
  const dependencies: Record<string, unknown> = {}, seen = new Set<ts.Type>();
  const localRoot = join(import.meta.dir, "../../../src") + "/";
  const visit = (type: ts.Type): void => {
    if (seen.has(type)) return; seen.add(type);
    if (type.isUnionOrIntersection()) { for (const part of type.types) visit(part); }
    if (type.flags & ts.TypeFlags.Object && (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) {
      for (const arg of checker.getTypeArguments(type as ts.TypeReference)) visit(arg);
    }
    const symbol = type.aliasSymbol ?? type.getSymbol();
    const declaration = symbol?.declarations?.find(node => node.getSourceFile().fileName.startsWith(localRoot));
    if (symbol && !declaration) return; // Built-in and external library graphs are not the host package contract.
    if (symbol && declaration && (ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration))) {
      const key = declaration.getSourceFile().fileName.slice(localRoot.length) + ":" + symbol.name;
      const members = type.getProperties().filter(member => !member.name.startsWith("__@"));
      dependencies[key] = { ...describe(type) as object, members: Object.fromEntries(members.map(member => [member.name, describe(checker.getTypeOfSymbolAtLocation(member, member.valueDeclaration ?? member.declarations?.[0] ?? declaration))])) };
    }
    for (const sig of [...type.getCallSignatures(), ...type.getConstructSignatures()]) {
      for (const parameter of sig.getParameters()) { const d = parameter.valueDeclaration ?? parameter.declarations?.[0]; if (d) visit(checker.getTypeOfSymbolAtLocation(parameter, d)); }
      visit(sig.getReturnType());
    }
    if (!symbol || declaration) for (const member of type.getProperties()) {
      if (member.name.startsWith("__@")) continue;
      const d = member.valueDeclaration ?? member.declarations?.[0]; if (!d) continue;
      if (ts.getCombinedModifierFlags(d) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) continue;
      visit(checker.getTypeOfSymbolAtLocation(member, d));
    }
  };
  const output: Record<string, unknown> = {};
  for (const name of [...values, ...types]) {
    const symbol = exports.get(name); if (!symbol) throw Error(`host API export removed: ${name}; restore it or raise the host API version`);
    const actual = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    const decl = actual.valueDeclaration ?? actual.declarations?.[0]; if (!decl) throw Error(`host API declaration missing: ${name}`);
    const type = values.includes(name) ? checker.getTypeOfSymbolAtLocation(actual, decl) : checker.getDeclaredTypeOfSymbol(actual);
    const item: Record<string, unknown> = { ...describe(type) as object };
    if (actual.flags & ts.SymbolFlags.Class || (types.includes(name) && !!(type.flags & ts.TypeFlags.Object))) {
      const instance = checker.getDeclaredTypeOfSymbol(actual);
      item.members = Object.fromEntries(instance.getProperties().filter(member => { if (member.name.startsWith("__@")) return false; const declaration = member.valueDeclaration ?? member.declarations?.[0]; return !declaration || !(ts.getCombinedModifierFlags(declaration) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)); }).sort((a, b) => a.name.localeCompare(b.name)).map(member => [member.name, describe(checker.getTypeOfSymbolAtLocation(member, member.valueDeclaration ?? member.declarations?.[0] ?? decl))]));
    }
    output[name] = item;
    visit(type);
    if (actual.flags & ts.SymbolFlags.Class) visit(checker.getDeclaredTypeOfSymbol(actual));
  }
  output.__dependencies = dependencies;
  return output;
}
