import { expect, test } from "bun:test";
import { SETUP_CONFIG_BYTES, setTomlPath } from "../src/setup-toml.ts";
const hook = { event: "SessionEnd", command: "bun --smol '/package with spaces/bin/amem.js' ingest kimi", timeout: 3 };
const parse = (text: string) => Bun.TOML.parse(text) as Record<string, any>;

test("setup TOML updates inline empty hooks without duplicate AOT declarations and keeps other bytes", () => {
  const trust = '[trust]\r\n"/project with spaces" = true # preserve\r\n', source = '# user prefix\r\nhooks = [] # hook comment\r\n' + trust;
  const output = setTomlPath(source, ["hooks"], [hook]);
  expect(parse(output).hooks).toEqual([hook]); expect(output).toContain(trust); expect(output).toContain("# hook comment\r\n"); expect(output.startsWith("# user prefix\r\n")).toBe(true);
  expect(parse(setTomlPath(output, ["hooks"], []))).toEqual(parse(source));
});
test("setup TOML preserves existing inline hooks and nested inline data when appending", () => {
  const source = 'hooks = [{ event = "Stop", command = "existing", options = { enabled = true, patterns = ["a", "b"] } }]\nmodel = "keep"\n';
  const existing = parse(source).hooks, output = setTomlPath(source, ["hooks"], [...existing, hook]);
  expect(parse(output).hooks).toEqual([...existing, hook]); expect(output).toContain('model = "keep"\n');
  expect(parse(setTomlPath(output, ["hooks"], existing))).toEqual(parse(source));
});
test("setup TOML replaces multiple array-of-table hooks including nested configuration", () => {
  const trust = '[trust]\nallow = ["/repo", "/other"] # keep trust\n', providers = '[providers."with.dot"]\nmodel = \'literal model\'\n';
  const source = '# prefix\n' + trust + '[[hooks]]\nevent = "Stop"\ncommand = "one"\n[hooks.options]\nenabled = true\npatterns = ["# comment", "[hooks]"]\n[[hooks]]\nevent = "SessionStart"\ncommand = "two"\n' + providers;
  const original = parse(source), output = setTomlPath(source, ["hooks"], [...original.hooks, hook]);
  expect(parse(output).hooks).toEqual([...original.hooks, hook]); expect(output).toContain(trust); expect(output).toContain(providers);
  const removed = setTomlPath(output, ["hooks"], undefined); expect(parse(removed).hooks).toBeUndefined(); expect(parse(removed).trust).toEqual(original.trust); expect(parse(removed).providers).toEqual(original.providers);
});
test("setup TOML scanner does not treat rich multiline string contents as headers or assignments", () => {
  const banner = 'banner = """\n# ordinary content\n[[hooks]]\nhooks = ["text, not syntax"]\n"""\n';
  const literal = "literal = '''\n[mcp_servers.amem]\ncommand = 'not a table'\n'''\n";
  const source = banner + literal + 'hooks = []\n[trust]\nenabled = true\n', output = setTomlPath(source, ["hooks"], [hook]);
  expect(output).toContain(banner); expect(output).toContain(literal); expect(parse(output).banner).toBe(parse(source).banner); expect(parse(output).literal).toBe(parse(source).literal); expect(parse(output).hooks).toEqual([hook]);
});
test("setup TOML standard MCP tables/subtables can be replaced and removed without changing other servers or trust", () => {
  const other = '[mcp_servers.other]\ncommand = "keep"\nargs = ["unchanged"]\n', trust = '[projects."/a/b"]\ntrust_level = "trusted" # keep comment\n';
  const source = '# original\n[mcp_servers.amem]\ncommand = "old"\nargs = ["old"]\n[mcp_servers.amem.env]\nPUBLIC_FIXTURE = "old"\n' + other + trust;
  const server = { command: "bun", args: ["--smol", "/new/bin/amem.js", "mcp"], env: { PUBLIC_FIXTURE: "new" } }, output = setTomlPath(source, ["mcp_servers", "amem"], server);
  expect(parse(output).mcp_servers.amem).toEqual(server); expect(parse(output).mcp_servers.other).toEqual(parse(source).mcp_servers.other); expect(output).toContain(other); expect(output).toContain(trust);
  const removed = setTomlPath(output, ["mcp_servers", "amem"], undefined); expect(parse(removed).mcp_servers.amem).toBeUndefined(); expect(parse(removed).mcp_servers.other).toEqual(parse(source).mcp_servers.other); expect(removed).toContain(trust);
});
test("setup TOML parent standard table permits an amem entry alongside dotted server assignments", () => {
  const source = '[mcp_servers]\nother.command = "keep"\nother.args = ["same"]\namem.command = "old"\namem.args = []\n[trust]\nallow = true\n';
  const output = setTomlPath(source, ["mcp_servers", "amem"], { command: "bun", args: ["mcp"] });
  expect(parse(output).mcp_servers).toEqual({ other: { command: "keep", args: ["same"] }, amem: { command: "bun", args: ["mcp"] } }); expect(output).toContain('other.command = "keep"\nother.args = ["same"]\n'); expect(output).toContain('[trust]\nallow = true\n');
});
test("setup TOML inline parent maps preserve other values and comments while changing only their subtree", () => {
  const source = 'mcp_servers = { amem = { command = "old", args = [] }, other = { command = "keep", enabled = false } } # map comment\n[trust]\nallow = ["x"]\n';
  const output = setTomlPath(source, ["mcp_servers", "amem"], { command: "bun", args: ["--smol", "mcp"] });
  expect(parse(output).mcp_servers.other).toEqual(parse(source).mcp_servers.other); expect(output).toContain("# map comment\n"); expect(output).toContain('[trust]\nallow = ["x"]\n');
  const removed = setTomlPath(output, ["mcp_servers", "amem"], undefined); expect(parse(removed).mcp_servers).toEqual({ other: { command: "keep", enabled: false } });
});
test("setup TOML quoted/dotted key identities do not match a similarly spelled other server", () => {
  const source = '["mcp_servers".\'amem\']\ncommand = "old"\n[mcp_servers."amem.with.dot"]\ncommand = "untouched"\n';
  const output = setTomlPath(source, ["mcp_servers", "amem"], undefined);
  expect(parse(output).mcp_servers.amem).toBeUndefined(); expect(parse(output).mcp_servers["amem.with.dot"]).toEqual({ command: "untouched" }); expect(output).toContain('[mcp_servers."amem.with.dot"]\ncommand = "untouched"\n');
});
test("setup TOML insertion and removal preserve explicitly or implicitly empty parent tables", () => {
  const only = '[mcp_servers.amem]\ncommand = "old"\n';
  expect(parse(setTomlPath(only, ["mcp_servers", "amem"], undefined))).toEqual({ mcp_servers: {} });
  const explicit = '[mcp_servers]\n# keep empty parent\n';
  const installed = setTomlPath(explicit, ["mcp_servers", "amem"], { command: "bun" });
  expect(parse(installed)).toEqual({ mcp_servers: { amem: { command: "bun" } } }); expect(installed).toContain("# keep empty parent\n");
  expect(parse(setTomlPath(installed, ["mcp_servers", "amem"], undefined))).toEqual({ mcp_servers: {} });
});
test("setup TOML leaves dates/times, number forms, quoted strings and arrays outside the target byte-identical", () => {
  const rich = 'date = 1979-05-27\ntime = 07:32:00.123\ninstant = 1979-05-27T07:32:00Z\nlocal = 1979-05-27T07:32:00\nnumber = 1_000\nfloat = inf\nnegative = -0.0\nstrings = ["한글", \'single " quote\', "escaped \\\" quote"]\n';
  const source = rich + 'hooks = []\n', output = setTomlPath(source, ["hooks"], [hook]);
  expect(output.startsWith(rich)).toBe(true); expect(String(parse(output).date)).toBe("1979-05-27"); expect(String(parse(output).instant)).toBe("1979-05-27T07:32:00Z"); expect(parse(output).number).toBe(1000); expect(parse(output).float).toBe(Infinity); expect(Object.is(parse(output).negative, -0)).toBe(true);
});
test("setup TOML no-op edits preserve every byte and generated escaped/temporal values roundtrip", () => {
  const source = '# untouched\r\nhooks=[]  # formatting\r\n[trust]\r\nallow=true\r\n';
  expect(setTomlPath(source, ["hooks"], [])).toBe(source); expect(setTomlPath(source, ["missing"], undefined)).toBe(source);
  const value = { text: 'line one\nline "two" \\ path', array: [true, 1, -0, Infinity, -Infinity, NaN], when: parse("v = 1979-05-27").v };
  const output = setTomlPath("", ["new"], value), read = parse(output).new;
  expect(read.text).toBe(value.text); expect(read.array).toEqual(value.array); expect(String(read.when)).toBe("1979-05-27");
});
test("setup TOML refuses invalid documents, unsupported values, oversized input and array traversal", () => {
  expect(() => setTomlPath("hooks = [}", ["hooks"], [])).toThrow("no configuration changed");
  expect(() => setTomlPath('[[hooks]]\nevent="Stop"\n', ["hooks", "event"], "new")).toThrow("no configuration changed");
  expect(() => setTomlPath('[[hooks]]\nevent="Stop"\n', ["hooks", "event"], undefined)).toThrow("no configuration changed");
  for (const value of [null, { absent: undefined }, () => true, new Date()]) expect(() => setTomlPath("", ["hooks"], value)).toThrow("no configuration changed");
  expect(() => setTomlPath("#" + "x".repeat(SETUP_CONFIG_BYTES), ["hooks"], [])).toThrow("no configuration changed");
  expect(() => setTomlPath("", [], [])).toThrow("no configuration changed"); expect(() => setTomlPath("", Array(9).fill("x"), [])).toThrow("no configuration changed");
});
