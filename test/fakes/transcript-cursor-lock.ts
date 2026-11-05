import { Database } from "bun:sqlite";
const file = process.argv[2];
if (!file) throw Error("cursor lock fixture needs its isolated database argument");
const db = new Database(file);
// Force dirty pages to spill and sync their journal before the parent's SIGKILL.
db.run("PRAGMA synchronous=FULL");
db.run("PRAGMA cache_size=1");
db.run("PRAGMA cache_spill=1");
db.run("BEGIN EXCLUSIVE");
if (process.argv[3] === "hot") db.run("UPDATE spill SET data=randomblob(4096)");
process.stdout.write("locked\n");
try {
  for await (const chunk of Bun.stdin.stream()) {
    if (new TextDecoder().decode(chunk).includes("release")) { await Bun.sleep(200); break; }
  }
} finally { db.run("ROLLBACK"); db.close(); }
