/** Internal keyset pages: bounds apply to row bodies, never to the total corpus. */
export interface ReadWindow {
  project: string;
  limit: number;
  since?: string;
  anchor?: string;
  prefix?: string;
  id?: string;
  after?: { position: number; id: string };
}
export interface ReadRef { id: string; at: string; position: number }
/** Fixed column names supplied by the three derived stores; all caller values remain SQL parameters. */
export function readWindowSql(window: ReadWindow, id: "id" | "ref") {
  if (!Number.isSafeInteger(window.limit) || window.limit < 1 || window.limit > 256) throw new Error("invalid read page limit");
  const bind: (string | number)[] = [];
  const position = window.anchor ? (bind.push(window.anchor), "abs(julianday(at) - julianday(?))") : "-julianday(at)";
  const columns = `CAST(${id} AS TEXT) AS candidate_id, at, ${position} AS candidate_position`;
  const where = ["project = ?"]; bind.push(window.project);
  if (window.since) { where.push("julianday(at) >= julianday(?)"); bind.push(window.since); }
  if (window.id !== undefined) { where.push(`${id} = ?`); bind.push(window.id); }
  if (window.prefix !== undefined) { where.push(`substr(${id}, 1, length(?)) = ?`); bind.push(window.prefix, window.prefix); }
  if (window.after) {
    where.push("(candidate_position > ? OR (candidate_position = ? AND candidate_id > ?))");
    bind.push(window.after.position, window.after.position, window.after.id);
  }
  return { columns, where, bind };
}
export const readRef = (row: { candidate_id: string; at: string; candidate_position: number }): ReadRef => ({ id: row.candidate_id, at: row.at, position: row.candidate_position });
