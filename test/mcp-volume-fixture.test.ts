import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { fts5Available } from "../src/memory/search-fts.ts";
import { createStandalonePolicy } from "../src/memory/policy.ts";
import { featureMasks, mcpVolumeRow, MCP_VOLUME_EXCERPT_BYTES } from "./fakes/mcp-volume-fixture.ts";

test("volume fixture keeps calibrated byte/character density and public feature combinations", async () => {
  const masks = featureMasks(1000), probes = new Map<number, ReturnType<typeof mcpVolumeRow>>();
  let chars = 0, unicode = 0;
  for (let i = 0; i < masks.length; i++) {
    const row = mcpVolumeRow(i, masks[i]!);
    expect(Buffer.byteLength(row.excerpt)).toBe(MCP_VOLUME_EXCERPT_BYTES);
    expect(row.excerpt).toContain("rankneedle");
    expect(row.excerpt.includes("exactanchor")).toBe(i === 0);
    chars += row.excerpt.length; unicode += Number(/[^\p{ASCII}]/u.test(row.excerpt));
    if (!probes.has(masks[i]!)) probes.set(masks[i]!, row);
  }
  expect(unicode).toBe(800);
  const expansion = 1 - chars / (masks.length * MCP_VOLUME_EXCERPT_BYTES);
  expect(expansion).toBeGreaterThan(0.015); expect(expansion).toBeLessThan(0.017);
  const policy = createStandalonePolicy();
  for (const row of probes.values()) expect(await policy.screen({ project: "synthetic", event: "Quiet", ...row })).toBe(true);
});

test.skipIf(!fts5Available())("volume fixture has about 185 actual unicode61 tokens per indexed body", () => {
  const db = new Database(":memory:");
  try {
    db.run("CREATE VIRTUAL TABLE docs USING fts5(body)");
    db.run("CREATE VIRTUAL TABLE terms USING fts5vocab(docs, 'row')");
    const masks = featureMasks(1000), put = db.query("INSERT INTO docs(body) VALUES (?)");
    db.transaction(() => { for (let i = 0; i < masks.length; i++) { const row = mcpVolumeRow(i, masks[i]!); put.run(`${row.excerpt}\n${row.paths.join(" ")}\nQuiet`); } })();
    const stats = db.query("SELECT COUNT(*) AS vocabulary, SUM(cnt) AS tokens FROM terms").get() as { vocabulary: number; tokens: number };
    expect(stats.vocabulary).toBeGreaterThan(10_000);
    expect(stats.tokens / masks.length).toBeGreaterThan(180); expect(stats.tokens / masks.length).toBeLessThan(190);
  } finally { db.close(); }
});
