import { expect, test } from "bun:test";
import { SETUP_CONFIG_BYTES, setTomlPath, updateTomlArray } from "../src/setup-toml.ts";
const hook = { event: "SessionEnd", command: "bun --smol '/package with spaces/bin/amem.js' ingest kimi", timeout: 3 };
const parse = (text: string) => Bun.TOML.parse(text) as Record<string, any>;

test.each(["", 'model = "keep"\n'])("removing the last dotted MCP entry retains its implicit parent beside later tables (%s)", original => {
  const installed = setTomlPath(original, ["mcp_servers", "amem"], { command: "bun", args: ["mcp"] });
  const later = '\n# later configuration\n[projects."/keep"]\ntrust_level = "trusted"\n';
  const removed = setTomlPath(installed + later, ["mcp_servers", "amem"], undefined);
  expect(parse(removed).mcp_servers).toEqual({}); expect(removed).toContain(later);
  const cleaned = setTomlPath(removed, ["mcp_servers"], undefined);
  expect(parse(cleaned).mcp_servers).toBeUndefined(); expect(parse(cleaned).projects["/keep"].trust_level).toBe("trusted");
  expect(cleaned).toContain(original); expect(cleaned).toContain(later);
});

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

test("surgical inline array append/removal keeps original element spelling, comments and CRLF", () => {
  const old = '{ event = "Stop", command = "old", timeout = 5.0, options = { keep = true } }';
  const source = '# prefix\r\nhooks = [\r\n  ' + old + ', # original row comment\r\n] # array comment\r\n[trust]\r\nallow = true # unchanged\r\n';
  const before = parse(source).hooks, appended = updateTomlArray(source, ["hooks"], [...before, hook]);
  expect(appended).toContain(old + ', # original row comment\r\n'); expect(appended).toContain('] # array comment\r\n[trust]\r\nallow = true # unchanged\r\n'); expect(parse(appended).hooks).toEqual([...before, hook]);
  const removed = updateTomlArray(appended, ["hooks"], before); expect(removed).toContain(old + ', # original row comment\r\n'); expect(parse(removed)).toEqual(parse(source)); expect(removed.replaceAll("\r\n", "")).not.toContain("\n");
});
test("surgical compact inline arrays handle empty, missing comma and first/middle/last removal", () => {
  for (const source of ['hooks=[]\n', 'hooks=[{event="Stop",command="a",timeout=5.0}]\n']) {
    const old = parse(source).hooks, appended = updateTomlArray(source, ["hooks"], [...old, hook]); expect(parse(appended).hooks).toEqual([...old, hook]);
    const restored = updateTomlArray(appended, ["hooks"], old); expect(parse(restored)).toEqual(parse(source)); if (old.length) expect(restored).toContain('timeout=5.0');
  }
  const a = '{ command="a", timeout=5.0 }', b = '{ command="b", timeout=6e0 }', c = '{ command="c", timeout=7_000 }', source = `hooks=[${a}, ${b}, ${c}]\n`, old = parse(source).hooks;
  for (const index of [0, 1, 2]) { const remaining = old.filter((_row: unknown, i: number) => i !== index), output = updateTomlArray(source, ["hooks"], remaining); expect(parse(output).hooks).toEqual(remaining); for (const [i, raw] of [a, b, c].entries()) if (i !== index) expect(output).toContain(raw); }
});
test("surgical inline array scanner respects commas/brackets/comment markers inside strings and nested values", () => {
  const raw = '{ command="echo [,] # text", options={ values=["a,b", "c]"], timeout=5.0 } }';
  const source = `hooks = [${raw}] # keep\n[trust]\nvalue="same"\n`, before = parse(source).hooks;
  const output = updateTomlArray(source, ["hooks"], [...before, hook]); expect(output).toContain(raw); expect(parse(output).hooks).toEqual([...before, hook]); expect(parse(updateTomlArray(output, ["hooks"], before))).toEqual(parse(source));
});
test("surgical AOT append keeps every original statement/comment/number/CRLF and emits new hooks as AOT", () => {
  const first = '[[hooks]] # first user row\r\nevent = "Stop"\r\ncommand = "old"\r\ntimeout = 5.0 # native spelling\r\n[hooks.options]\r\nkeep = true\r\n';
  const source = '# prefix\r\n' + first + '[trust]\r\nallow = ["same"] # keep\r\n', before = parse(source).hooks;
  const output = updateTomlArray(source, ["hooks"], [...before, hook]); expect(output.startsWith(source)).toBe(true); expect(output).toContain(first); expect(output.match(/\[\[hooks\]\]/g)).toHaveLength(2); expect(parse(output).hooks).toEqual([...before, hook]); expect(output.replaceAll("\r\n", "")).not.toContain("\n");
  const later = 'owner = "later"\r\n' + output, removed = updateTomlArray(later, ["hooks"], before); expect(removed).toContain(first); expect(parse(removed).owner).toBe("later"); expect(parse(removed).hooks).toEqual(before);
});
test("surgical AOT removal retains surviving nested table source and unrelated tables between rows", () => {
  const first = '[[hooks]]\nevent="Stop"\ncommand="first"\ntimeout=5.0\n[hooks.options]\na="keep"\n', trust = '[trust]\nallowed=true # between rows\n', second = '[[hooks]]\nevent="SessionEnd"\ncommand="second"\ntimeout=6e0\n';
  const source = first + trust + second, old = parse(source).hooks;
  const onlySecond = updateTomlArray(source, ["hooks"], [old[1]]); expect(onlySecond).toContain(second); expect(onlySecond).toContain(trust); expect(parse(onlySecond).hooks).toEqual([old[1]]);
  const onlyFirst = updateTomlArray(source, ["hooks"], [old[0]]); expect(onlyFirst).toContain(first); expect(onlyFirst).toContain(trust); expect(parse(onlyFirst).hooks).toEqual([old[0]]);
  expect(parse(updateTomlArray(source, ["hooks"], [])).hooks).toEqual([]);
});
test("surgical array updates support qualified standard-table and quoted key assignments without rewriting values", () => {
  const source = '[settings]\n"hook.list" = [{ command="old", timeout=5.0 }]\n[trust]\nvalue=true\n', path = ["settings", "hook.list"], before = parse(source).settings["hook.list"];
  const output = updateTomlArray(source, path, [...before, hook]); expect(output).toContain('{ command="old", timeout=5.0 }'); expect(parse(output).settings["hook.list"]).toEqual([...before, hook]); expect(output).toContain('[trust]\nvalue=true\n');
});
test("surgical array no-op is byte exact, while replacements/reorders/inline-parent layouts refuse", () => {
  const source = 'hooks=[{command="a",timeout=5.0},{command="b",timeout=6e0}] # keep\r\n', before = parse(source).hooks;
  expect(updateTomlArray(source, ["hooks"], before)).toBe(source);
  expect(() => updateTomlArray(source, ["hooks"], [before[1], before[0]])).toThrow("no configuration changed");
  expect(() => updateTomlArray(source, ["hooks"], [before[0], { command: "changed" }])).toThrow("no configuration changed");
  expect(() => updateTomlArray('settings={hooks=[{command="old"}]}\n', ["settings", "hooks"], [{ command: "old" }, hook])).toThrow("no configuration changed");
  expect(parse(updateTomlArray('[trust]\na=true\n', ["hooks"], [hook]))).toEqual({ trust: { a: true }, hooks: [hook] });
});

test("surgical array insertion into a missing CRLF path preserves old bytes and uses CRLF for new syntax", () => {
  const source = '# original\r\n[trust]\r\nallow = true # same bytes\r\n';
  const output = updateTomlArray(source, ["hooks"], [hook]);
  expect(output).toContain(source.slice(source.indexOf("[trust]"))); expect(output.startsWith('# original\r\n')).toBe(true); expect(output.replaceAll("\r\n", "")).not.toContain("\n"); expect(parse(output)).toEqual({ hooks: [hook], trust: { allow: true } });
  const nested = '[settings]\r\nowner = "untouched" # keep\r\n[trust]\r\nallow = true\r\n';
  const child = updateTomlArray(nested, ["settings", "hooks"], [hook]);
  expect(child).toContain('owner = "untouched" # keep\r\n'); expect(child).toContain('[trust]\r\nallow = true\r\n'); expect(child.replaceAll("\r\n", "")).not.toContain("\n"); expect(parse(child).settings.hooks).toEqual([hook]);
});
test("removing every CRLF AOT element retains the original EOL even when no source statements remain", () => {
  const source = '[[hooks]]\r\nevent="Stop"\r\ncommand="old"\r\ntimeout=5.0\r\n';
  const output = updateTomlArray(source, ["hooks"], []);
  expect(parse(output)).toEqual({ hooks: [] }); expect(output).toContain("\r\n"); expect(output.replaceAll("\r\n", "")).not.toContain("\n");
  const comments = '# preserve comment\r\n' + source, kept = updateTomlArray(comments, ["hooks"], []);
  expect(kept.startsWith('# preserve comment\r\n')).toBe(true); expect(parse(kept)).toEqual({ hooks: [] }); expect(kept.replaceAll("\r\n", "")).not.toContain("\n");
});

test("semantic removal drops append-only leading space from an otherwise empty inline array", () => {
  const source = 'hooks=[]\n', installed = updateTomlArray(source, ["hooks"], [hook]);
  expect(updateTomlArray(installed, ["hooks"], [])).toBe(source);
});
test("semantic tail removal keeps surviving source without leaving separator padding", () => {
  const raw = '{command="legacy",timeout=5.0}', source = `hooks=[${raw}]\n`, original = parse(source).hooks;
  const installed = updateTomlArray(source, ["hooks"], [...original, hook]);
  expect(updateTomlArray(installed, ["hooks"], original)).toBe(source);
});
test("semantic removal drops the removed row indentation and leading blank line with CRLF intact", () => {
  const source = 'hooks=[\r\n]\r\n', installed = updateTomlArray(source, ["hooks"], [hook]);
  expect(updateTomlArray(installed, ["hooks"], [])).toBe(source);
});
test("removal preserves the newline terminating a preceding comment and every surviving value byte", () => {
  const raw = '{command="legacy",timeout=5.0}', source = `hooks=[${raw}, # keep this comment\r\n  {command="remove"}\r\n]\r\n`;
  const output = updateTomlArray(source, ["hooks"], [parse(source).hooks[0]]);
  expect(output).toContain(`${raw}, # keep this comment\r\n`); expect(parse(output).hooks).toEqual([parse(source).hooks[0]]); expect(output.replaceAll("\r\n", "")).not.toContain("\n");
});
test("apply then undo of a one-element inline array is byte-exact", () => {
  const source = "items = [1]\n", appended = updateTomlArray(source, ["items"], [1, 2]);
  expect(parse(appended).items).toEqual([1, 2]);
  expect(updateTomlArray(appended, ["items"], [1])).toBe(source);
});
