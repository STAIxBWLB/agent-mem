import { expect, test } from "bun:test";
import { assertMcpVolumeReply, assertMcpVolumeSearch } from "../scripts/measure-mcp-volume.ts";
import { MCP_VOLUME_EXCERPT_BYTES, MCP_VOLUME_ROWS } from "./fakes/mcp-volume-fixture.ts";

const project = "synthetic-volume-project";
function result() {
  return { engine: "fts5", hits: Array.from({ length: 10 }, (_, i) => ({ source: "capture", evidence: false, capture: {
    id: i === 0 ? MCP_VOLUME_ROWS : i + 1, project, at: "2026-10-26T01:00:00.000Z",
    excerpt: (i === 0 ? "rankneedle exactanchor preciseanchor" : "rankneedle public").padEnd(MCP_VOLUME_EXCERPT_BYTES, " "),
  } })) };
}

test("volume readiness rejects error, wrong-id and non-JSON-RPC frames", () => {
  expect(assertMcpVolumeReply({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "amem" } } }, 1)).toEqual({ serverInfo: { name: "amem" } });
  for (const value of [{ id: 1, result: {} }, { jsonrpc: "2.0", id: 2, result: {} }, { jsonrpc: "2.0", id: 1, error: { code: -1 } }, { jsonrpc: "2.0", id: 1, result: null }]) {
    expect(() => assertMcpVolumeReply(value, 1)).toThrow("JSON-RPC");
  }
});

test("volume search requires a broad FTS result with the oldest precise capture first", () => {
  expect(assertMcpVolumeSearch(result(), project)).toEqual({ engine: "fts5", first: MCP_VOLUME_ROWS, hits: 10 });
  const prefixOnly = result(); prefixOnly.hits[0]!.capture.id = 1;
  expect(() => assertMcpVolumeSearch(prefixOnly, project)).toThrow("oldest best");
  const fallback = result(); fallback.engine = "substring";
  expect(() => assertMcpVolumeSearch(fallback, project)).toThrow("FTS5");
  const capped = result(); capped.hits = capped.hits.slice(0, 1);
  expect(() => assertMcpVolumeSearch(capped, project)).toThrow("ten hits");
  const missingOldest = result(); missingOldest.hits.reverse();
  expect(() => assertMcpVolumeSearch(missingOldest, project)).toThrow("oldest best");
});

test("volume search rejects foreign, duplicate, curated-evidence and malformed capture rows", () => {
  const foreign = result(); foreign.hits[0]!.capture.project = "foreign-project";
  const duplicate = result(); duplicate.hits[1]!.capture.id = duplicate.hits[0]!.capture.id;
  const evidence = result(); evidence.hits[0]!.evidence = true;
  const malformed = result(); malformed.hits[0]!.capture.at = "invalid";
  const truncated = result(); truncated.hits[0]!.capture.excerpt = "rankneedle exactanchor preciseanchor";
  for (const value of [foreign, duplicate, evidence, malformed, truncated]) expect(() => assertMcpVolumeSearch(value, project)).toThrow("contract");
});
