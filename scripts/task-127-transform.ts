/** Disposable task127 diagnostics. Replacements are in-memory and never shipped. */
export const PHASES: Record<number, string> = {
  1: "process.entry", 2: "capture.import.enter", 3: "capture.import.settled", 4: "receipt.ready",
  5: "scan.enter", 6: "scan.return", 7: "replay.enter", 8: "replay.return", 9: "store.constructor.enter", 10: "store.constructor.return",
  11: "append.enter", 12: "append.return", 13: "store.close.enter", 14: "store.close.return",
  15: "output.write.enter", 16: "output.write.settled", 17: "stop.enter", 18: "rss.read.enter", 19: "rss.read.return",
  20: "self.signal.request", 21: "self.signal.return", 22: "exit.intent",
  100: "cursor.setup.enter", 101: "cursor.owned.enter", 102: "cursor.open.enter", 103: "cursor.open.return",
  104: "cursor.init.enter", 105: "cursor.init.return", 106: "cursor.identity.commit.enter", 107: "cursor.identity.commit.return",
  108: "scan.read.bytes", 109: "cursor.final.update", 110: "cursor.final.commit.enter", 111: "cursor.final.commit.return",
  112: "cursor.close.enter", 113: "cursor.close.return", 114: "transcript.close.enter", 115: "transcript.close.return", 116: "scan.consumed.bytes",
  150: "publication.admission", 151: "publication.write.enter", 152: "publication.write.return", 153: "publication.rename.enter", 154: "publication.rename.return",
  200: "parent.worker.enter", 201: "parent.worker.spawn", 202: "parent.metadata.enter", 203: "parent.metadata.return",
  204: "parent.watchdog", 205: "parent.stop.enter", 206: "parent.signal.request", 207: "parent.signal.return", 208: "parent.child.exited",
  209: "parent.reap.enter", 210: "parent.reap.return", 211: "parent.output.barrier", 212: "parent.accounting.return",
};
const p = (id: number, a = "0", b = "0") => `(globalThis as any).__t127phase(${id},${a},${b});`;
function once(source: string, anchor: string, replacement: string): string {
  if (source.split(anchor).length !== 2) throw new Error(`task127 anchor mismatch: ${anchor.slice(0, 100)}`);
  return source.replace(anchor, replacement);
}
export function transformSource(file: string, original: string): string {
  let source = original;
  const before = (anchor: string, id: number, a?: string) => { source = once(source, anchor, p(id, a) + anchor); };
  const after = (anchor: string, id: number, a?: string) => { source = once(source, anchor, anchor + p(id, a)); };
  if (file === "test/fakes/hooks-fixture.ts") {
    source = once(source, "  const env: NodeJS.ProcessEnv = {", "  const env: NodeJS.ProcessEnv = { ...(globalThis as any).__t127fixtureEnv(),");
  } else if (file === "src/session-brief-worker.ts") {
    before('  const captureModule = import("./memory/capture.ts");', 2);
    after("captureReady = true;", 3);
    after("receiptReady = true;", 4);
    before("          const scanned = await scanHookTranscriptTail", 5);
    before("          if (scanned) progress(scanned);", 6, "scanned?.offset ?? -1");
    before("      const drained = await drainHookCaptures", 7);
    before("      captured ||= drained.captured.includes(options.current);", 8, "drained.captured.length");
    source = once(source, "        store ??= new CaptureStore({ memoryDir: options.base!, project, busyTimeoutMs: 0, cwd: options.cwd });",
      `        if (!store) { ${p(9)} store = new CaptureStore({ memoryDir: options.base!, project, busyTimeoutMs: 0, cwd: options.cwd }); ${p(10)} }`);
    before("        const appended = store.append(input, { receipt });", 11);
    after("        const appended = store.append(input, { receipt });", 12);
    source = once(source, "    } finally { store?.close(); }", `    } finally { ${p(13, "Number(!!store)")} store?.close(); ${p(14)} }`);
    before("    await Bun.stdout.write(body.slice(0, -1)", 15);
    before("    stop();\n  };", 16);
    after("  const stop: () => never = () => {", 17);
    before("    const self = hookRssReading();", 18);
    before("    if (owned) try { process.kill", 19);
    source = once(source, 'if (owned) try { process.kill(-process.pid, "SIGKILL"); }', `if (owned) try { ${p(20)} process.kill(-process.pid, "SIGKILL"); ${p(21)} }`);
    before("    process.exit(0);", 22);
  } else if (file === "src/hooks.ts") {
    after("  const workDeadline = deadline - WORKER_CLEANUP_MS;", 200, "performance.timeOrigin + workDeadline");
    after("    owned = child;", 201, "child.pid");
    source = once(source, "setTimeout(() => { stop(); resolve(undefined); }, Math.max(1, workDeadline - performance.now()))",
      `setTimeout(() => { ${p(204)} stop(); resolve(undefined); }, Math.max(1, workDeadline - performance.now()))`);
    source = once(source, "child.exited.then(code => { exited = true; return code; })", `child.exited.then(code => { ${p(208, "child.pid", "code")} exited = true; return code; })`);
    before("    metadata = await parentProject(options, base, workDeadline);", 202);
    after("    metadata = await parentProject(options, base, workDeadline);", 203);
    before("    tracker!.captureLive();", 205);
    source = once(source, 'try { process.kill(-owned.pid, "SIGKILL"); }', `try { ${p(206, "owned.pid")} process.kill(-owned.pid, "SIGKILL"); ${p(207, "owned.pid")} }`);
    before("      const reaped = exited || !(await boundedWait(exit!)).late;", 209);
    after("      const reaped = exited || !(await boundedWait(exit!)).late;", 210, "Number(reaped)");
    after('      const body = reaped ? await boundedWait(output!) : { late: true };', 211, "Number(body.late)");
    after("      const accounting = tracker!.finish(workerRawKB);", 212);
  } else if (file === "src/hook-transcript.ts") {
    after("  const value = object(input);", 100);
    after("function cursorDatabase(file: string, dev: string, ino: string, size: number): Database {", 101);
    before("  const db = new Database(file);", 102);
    after("  const db = new Database(file);", 103);
    before("    db.transaction(() => {", 104);
    after("    }).immediate();", 105);
    before('      db.run("COMMIT"); db.run("BEGIN IMMEDIATE");', 106);
    after('      db.run("COMMIT"); db.run("BEGIN IMMEDIATE");', 107);
    after("    const length = readSync(fd, bytes, 0, bytes.length, cursor.offset);", 108, "length");
    source = once(source, '    db.run("COMMIT");\n    return { offset:',
      `    ${p(116, "start")}${p(110)}db.run("COMMIT");${p(111)}\n    return { offset:`);
    source = once(source, 'db.run("ROLLBACK");', `${p(112)}db.run("ROLLBACK");`);
    source = once(source, "db.close(); } } finally { closeSync(fd); }", `db.close(); ${p(113)} } } finally { ${p(114)}closeSync(fd);${p(115)} }`);
    // H/PU has a conditional final UPDATE; main/P/PW has the same final UPDATE inline.
    const update = 'db.query("UPDATE cursor SET offset=?,dev=?,ino=?,size=?,title=?,at=?,skipping=? WHERE id=1")';
    source = once(source, update, p(109) + update);
  } else if (file === "src/hook-spool.ts") {
    after('function publishCapture(event: string, capture: NormalizedCaptureFields, options: Options, nonce = randomBytes(16).toString("hex")): PendingHookCapture {', 150);
    if (source.includes('writeFileSync(fd, bytes);')) {
      before("    writeFileSync(fd, bytes);", 151); after("    writeFileSync(fd, bytes);", 152);
      before("    renameSync(temporary, join(destination, name));", 153); after("    renameSync(temporary, join(destination, name));", 154);
    } else {
      source = once(source, 'try { writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" }); renameSync(temporary, join(destination, name)); }',
        `try { ${p(151)}writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });${p(152)}${p(153)}renameSync(temporary, join(destination, name));${p(154)} }`);
    }
  } else if (file === "scripts/measure-transcript-budget.ts") {
    const sample = (stage: string, current: string) => `(globalThis as any).__t127r1('${stage}', ${current}, diagnostic, performance.timeOrigin + exitAt, R1_POST_EXIT_WINDOW_MS)`;
    source = once(source, "  let alive = ownedHelpers();", `  let alive = await ${sample("before", "ownedHelpers()")};`);
    source = once(source, "{ await Bun.sleep(10); alive = ownedHelpers(); }", `{ await Bun.sleep(10); alive = await ${sample("sample", "ownedHelpers()")}; }`);
    source = once(source, "  const survivalMs = performance.now() - exitAt;", `  alive = await ${sample("after", "ownedHelpers()")};\n  const survivalMs = performance.now() - exitAt;`);
    source = once(source, "        await judgeR1(metric?.abandonedChildren ?? 0, { event, logicalRun, followUp });", "        (globalThis as any).__t127cursorFile(file);\n        await judgeR1(metric?.abandonedChildren ?? 0, { event, logicalRun, followUp });");
    source = once(source, '          const db = new Database(file, { readonly: true });\n          try { offset = (db.query("SELECT offset FROM cursor").get() as { offset: number }).offset; offsetSource = "cursor"; }',
      '          try { offset = await (globalThis as any).__t127readCursor(file, { event, logicalRun, followUp }); offsetSource = "cursor"; }');
    source = once(source, "          } finally { db.close(); }", "          }");
  }
  return source;
}
