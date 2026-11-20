import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

/** The panel module's own node stub: every rendered value is a text prop, so a string in the tree is what the person sees. */
type Node = { tag: string; props: Record<string, unknown>; kids: Node[]; append(...kids: Node[]): void; replaceChildren(...kids: Node[]): void; querySelectorAll(): unknown[]; contains(): boolean };
const node = (tag: string, props: Record<string, unknown> = {}, ...kids: Node[]): Node => ({ tag, props, kids,
  append(...items) { this.kids.push(...items); }, replaceChildren(...items) { this.kids = [...items]; }, querySelectorAll() { return []; }, contains() { return false; } });
function mountPanel() {
  const mount = node("mount"), buttons: Node[] = [];
  let snapshot: ((s: Record<string, unknown>) => void) | undefined;
  const host = { tool: "amem", mount, navigate() {}, action() {}, onSnapshot(cb: typeof snapshot) { snapshot = cb; },
    ui: { h: node, button: (text: string, click: () => void) => { const button = node("button", { text, click }); buttons.push(button); return button; }, rows: () => null,
      notice: (text: string) => node("notice", { text }), row: (props: Record<string, unknown>) => node("row", props),
      empty: (text: string) => node("empty", { text }), detail: (props: Record<string, unknown>) => node("detail", props) } };
  const source = readFileSync(new URL("../src/ui/panel.js", import.meta.url), "utf8");
  const render = runInNewContext(source.replace("export default", ""), { document: { activeElement: null } }) as (host: unknown) => { show(id: string): void };
  render(host).show("review");
  return { emit: snapshot!, root: () => mount.kids[0]!, buttons };
}

test("review uses host buttons and renders stored evidence as text with missing provenance explicit", () => {
  type Node = { tag: string; props: Record<string, unknown>; kids: unknown[]; append(...kids: unknown[]): void; replaceChildren(...kids: unknown[]): void; querySelectorAll(): unknown[]; contains(): boolean };
  const node = (tag: string, props: Record<string, unknown> = {}, ...kids: unknown[]): Node => ({ tag, props, kids,
    append(...items) { this.kids.push(...items); }, replaceChildren(...items) { this.kids = items; }, querySelectorAll() { return []; }, contains() { return false; } });
  const buttons: string[] = [];
  const clicks = new Map<string, () => void>();
  let navigation: unknown[] = [];
  let detail: Record<string, unknown> | undefined;
  let snapshot: ((s: Record<string, unknown>) => void) | undefined;
  const host = { tool: "amem", mount: node("mount"), navigate(...args: unknown[]) { navigation = args; }, action() {},
    onSnapshot(cb: typeof snapshot) { snapshot = cb; }, ui: {
      h: node, button(label: string, click: () => void) { buttons.push(label); clicks.set(label, click); return node("button", { text: label }); },
      rows(items: unknown[], render: (item: never) => unknown) { return items.length ? node("rows", {}, ...items.map(item => render(item as never))) : null; },
      notice: (text: string) => node("notice", { text }),
      row: (props: Record<string, unknown>) => node("row", props), empty: (text: string) => node("empty", { text }),
      detail(props: Record<string, unknown>) { detail = props; return node("detail", props); },
    } };
  const source = readFileSync(new URL("../src/ui/panel.js", import.meta.url), "utf8");
  const render = runInNewContext(source.replace("export default", ""), { document: { activeElement: null } }) as (host: unknown) => { show(id: string): void };
  render(host).show("review");
  const quote = "<script>an evidence quote is text</script>";
  snapshot!({ project: "fixture", projects: ["fixture"], selected: "candidate", rows: [{ id: "candidate", kind: "correction", text: "Proposed correction", createdAt: "2026-11-04T00:00:00Z", acceptable: true, edit: null,
    diff: { now: "Old", proposed: "New", reason: "Evidence" }, evidence: ["session:reference"], overlaps: [], targets: [{ id: "target", text: quote, at: "2026-11-03T00:00:00Z", kind: "finding" }] }] });
  expect(buttons).toContain("Accept");
  expect(buttons).toContain("Back to the queue");
  const sections = detail!.sections as { title: string; body: Node }[];
  const evidence = JSON.stringify(sections.find(s => s.title.startsWith("Evidence"))!.body);
  expect(evidence).toContain(quote);
  // #323: a row without origin says so explicitly; it is never inferred.
  expect(evidence).toContain("Origin unavailable: the proposer supplied no session or agent.");
  expect((detail!.provenance as { label: string; value: string }[]).find(row => row.label === "Origin")?.value).toBe("unavailable");
  expect(evidence).not.toContain("innerHTML");
  snapshot!({ project: null, projects: ["fixture"], error: "Requested project is unavailable" });
  expect(buttons).toContain("Choose project fixture");
  clicks.get("Choose project fixture")!();
  expect(navigation).toEqual(["amem", "review", { project: "fixture" }]);
});

test("#525: the picker renders each project's class as the text of its option", () => {
  const panel = mountPanel();
  const options = () => {
    const label = panel.root().kids.find(kid => kid.tag === "label")!, select = label.kids.find(kid => kid.tag === "select")!;
    // The picker hands the shell one option list, so the stub flattens what the real host mounts as children.
    return (select.kids as unknown as Node[][]).flat();
  };
  panel.emit({ project: null, projects: ["example.test/admitted", "scratch/widget@1a2b3c4d", "https://github.com/acme/captured.git",
    "https://github.com/acme/scaffold.git", "https://github.com/acme/restored.git", "https://github.com/acme/shadow.git"],
    gaps: { "scratch/widget@1a2b3c4d": "local-key", "https://github.com/acme/captured.git": "capture-only",
      "https://github.com/acme/scaffold.git": "no-memory", "https://github.com/acme/restored.git": "curated-unadmitted",
      "https://github.com/acme/shadow.git": "unverified" } });
  expect(options().map(option => option.props.text)).toEqual([
    "Choose an active project",
    "example.test/admitted",
    "scratch/widget@1a2b3c4d (local-key, outside inventory)",
    "https://github.com/acme/captured.git (capture only, outside inventory)",
    "https://github.com/acme/scaffold.git (no memory yet, outside inventory)",
    "https://github.com/acme/restored.git (curated, not admitted)",
    "https://github.com/acme/shadow.git (state unverified)",
  ]);
  // A project inside the inventory keeps the bare key, and the chosen one is the selected option.
  panel.emit({ project: "example.test/admitted", projects: ["example.test/admitted", "https://github.com/acme/captured.git"],
    gaps: { "https://github.com/acme/captured.git": "capture-only" } });
  expect(options().map(option => option.props.text)).toEqual(["example.test/admitted", "https://github.com/acme/captured.git (capture only, outside inventory)"]);
  expect((options()[0] as unknown as { selected?: boolean }).selected).toBe(true);
  // The mark is a class, never a path or a stored key of its own.
  expect(JSON.stringify(options().map(option => option.props))).not.toContain("/projects/");
});

test("#525: a single project carries its class in the paragraph and in the choose button", () => {
  const panel = mountPanel();
  const gaps = { "https://github.com/acme/captured.git": "capture-only" };
  panel.emit({ project: null, projects: ["https://github.com/acme/captured.git"], gaps });
  const paragraph = panel.root().kids.find(kid => kid.tag === "p");
  expect(paragraph?.props.text).toBe("Project https://github.com/acme/captured.git (capture only, outside inventory)");
  // The refusal of the only listed project keeps the class on the button that selects it again.
  panel.emit({ project: null, projects: ["https://github.com/acme/captured.git"], gaps, error: "sync placement realm is outside the activated inventory" });
  expect(panel.buttons.map(button => button.props.text)).toEqual(["Choose project https://github.com/acme/captured.git (capture only, outside inventory)"]);
  expect(JSON.stringify(panel.buttons.map(button => button.props))).not.toContain("/projects/");
});
