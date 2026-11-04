import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

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
  expect(evidence).toContain("not recorded in the candidate store");
  expect(evidence).not.toContain("innerHTML");
  snapshot!({ project: null, projects: ["fixture"], error: "Requested project is unavailable" });
  expect(buttons).toContain("Choose project fixture");
  clicks.get("Choose project fixture")!();
  expect(navigation).toEqual(["amem", "review", { project: "fixture" }]);
});
