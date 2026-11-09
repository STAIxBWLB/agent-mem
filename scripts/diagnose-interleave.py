#!/usr/bin/env python3
"""Finite Linux-only, fixed-CPU interleave diagnostic; no product, assertion or budget changes."""
import argparse
import collections
import hashlib
import json
import os
import re
import selectors
import shutil
import signal
import subprocess
import sys
import tarfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FILES = {
    "A": ["test/hook-transcript-interleave.test.ts"],
    "B": ["test/hook-transcript-interleave.test.ts"],
    "C": ["test/hook-jcode-journal.test.ts", "test/hook-transcript-interleave.test.ts"],
}
SCHEDULE = ("ABC", "BCA", "CAB")
MAX_LOG = 256 * 1024
MAX_RAW_ARCHIVE = 32 * 1024 * 1024
MAX_COMPRESSED_ARCHIVE = 8 * 1024 * 1024
MAX_FILES = 20000


def inside(value, root):
    value = value.removesuffix(" (deleted)")
    return value == str(root) or value.startswith(str(root) + "/")


def process_receipt(root):
    rows = []
    try:
        procs = list(Path("/proc").iterdir())[:8192]
    except OSError as error:
        raise RuntimeError("process receipt unavailable") from error
    if len(procs) >= 8192:
        raise RuntimeError("process receipt enumeration truncated")
    for proc in procs:
        if not proc.name.isdigit():
            continue
        try:
            fields = (proc / "stat").read_text().rsplit(")", 1)[1].split()
            cwd = os.readlink(proc / "cwd")
            env = (proc / "environ").read_bytes()[:262144].split(b"\0")
            env_owned = any(x.startswith((b"TMPDIR=", b"HOME=")) and inside(os.fsdecode(x.split(b"=", 1)[1]), root) for x in env if b"=" in x)
            cmd = (proc / "cmdline").read_bytes()[:65536].split(b"\0")
            cmd_owned = any(inside(os.fsdecode(x), root) for x in cmd if x)
            cwd_owned = inside(cwd, root)
            if env_owned or cmd_owned or cwd_owned:
                rows.append({"pid": int(proc.name), "state": fields[0], "ppid": int(fields[1]), "pgid": int(fields[2]),
                             "startTicks": int(fields[19]), "cwdOwned": cwd_owned, "cwdDeleted": cwd.endswith(" (deleted)"),
                             "environmentOwned": env_owned, "commandOwned": cmd_owned,
                             "program": Path(os.fsdecode(cmd[0])).name if cmd and cmd[0] else "unknown"})
        except (OSError, ValueError, IndexError):
            continue
    return sorted(rows, key=lambda row: row["pid"])


def temp_receipt(root):
    files = dirs = size = 0
    for current, children, names in os.walk(root, followlinks=False):
        dirs += len(children)
        for name in names:
            files += 1
            try:
                size += (Path(current) / name).lstat().st_size
            except OSError:
                pass
        if files + dirs >= MAX_FILES:
            return {"files": files, "directories": dirs, "bytes": size, "truncated": True}
    return {"files": files, "directories": dirs, "bytes": size, "truncated": False}


def snapshot_evidence(trial_dir):
    found = []
    for index, path in enumerate(sorted(trial_dir.rglob("snapshot.json"))):
        if index >= 64:
            found.append({"truncated": True, "reason": "snapshot count limit"})
            break
        try:
            if path.is_symlink() or path.stat().st_size > 1024 * 1024:
                continue
            data = json.loads(path.read_text())
            event = data.get("event")
            if event not in ("Stop", "SessionEnd"):
                continue
            captures = data.get("captureRows", [])
            pending = data.get("pending", [])
            compact_capture = any(row.get("event") == "Compact" for row in captures)
            compact_pending = any(row.get("event") == "Compact" for row in pending)
            offsets = [row.get("rows", []) for row in data.get("cursorRows", [])]
            flat = [item.get("offset") for group in offsets for item in group if isinstance(item, dict)]
            recap_end = (data.get("transcript") or {}).get("recapEnd")
            compact_end = (data.get("transcript") or {}).get("compactEnd")
            if data.get("errors"):
                classification = "unknown"
            elif compact_capture:
                classification = "compact-committed"
            elif compact_pending:
                classification = "staged-pending"
            elif recap_end is not None and compact_end is not None and any(value == recap_end for value in flat) and recap_end < compact_end:
                classification = "never-scanned"
            else:
                classification = "unknown"
            evidence = {"snapshot": str(path.relative_to(trial_dir)), "event": event,
                          "classification": classification, "cursorRows": data.get("cursorRows", []),
                          "transcript": data.get("transcript"), "pending": pending,
                          "captureRows": captures, "metric": data.get("metric"), "errors": data.get("errors", [])}
            encoded = json.dumps(evidence, ensure_ascii=False)
            if len(encoded.encode("utf-8")) > 64 * 1024:
                evidence = {"snapshot": str(path.relative_to(trial_dir)), "event": event,
                            "classification": classification, "cursorRowsCount": len(data.get("cursorRows", [])),
                            "pendingCount": len(pending), "captureRowsCount": len(captures),
                            "metric": data.get("metric"), "errors": data.get("errors", [])[:16], "truncated": True}
            found.append(evidence)
        except (OSError, ValueError, TypeError):
            continue
    return found


def parse_log(path):
    text = path.read_text(errors="replace")
    text = re.sub(r"\x1b\[[0-9;]*m", "", text)
    files, failures, current = [], [], None
    for line in text.splitlines():
        if line.startswith("test/") and line.endswith(":"):
            current = line[:-1]
            files.append(current)
        if line.startswith("(fail) "):
            failures.append({"file": current, "name": re.sub(r"\s+\[[^]]+\]$", "", line[7:])[:1000]})
        elif re.match(r"^\s*[✗×]\s+", line):
            failures.append({"file": current, "name": re.sub(r"^\s*[✗×]\s+", "", line).strip()[:1000]})
    summary = re.search(r"Ran (\d+) tests? across (\d+) files?", text)
    pass_count = re.search(r"(?:^|\s)(\d+) pass(?:ed)?(?:\s|$)", text, re.MULTILINE)
    fail_count = re.search(r"(?:^|\s)(\d+) fail(?:ed)?(?:\s|$)", text, re.MULTILINE)
    unique_failures = list({(row["file"], row["name"]): row for row in failures}.values())
    return {"filesObserved": files[:128], "summaryPresent": bool(summary),
            "tests": int(summary[1]) if summary else None, "fileCount": int(summary[2]) if summary else None,
            "passCount": int(pass_count[1]) if pass_count else None,
            "failCount": int(fail_count[1]) if fail_count else None,
            "failures": unique_failures[:256], "logBytesRetained": path.stat().st_size,
            "logTruncated": path.stat().st_size >= MAX_LOG}


def archive(out):
    path = out / "diagnostic.tar.gz"
    members = []
    total = 0
    for item in sorted(out.rglob("*")):
        rel = item.relative_to(out)
        if rel.parts[0] in ("tmp", "diagnostic.tar.gz") or item.is_symlink() or not item.is_file():
            continue
        size = item.stat().st_size
        total += size
        members.append((item, rel.as_posix(), size))
        if len(members) > MAX_FILES or total > MAX_RAW_ARCHIVE:
            raise RuntimeError("archive source bounds exceeded")
    with tarfile.open(path, "w:gz") as tar:
        for item, name, _ in members:
            info = tar.gettarinfo(str(item), arcname=name)
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            with item.open("rb") as source:
                tar.addfile(info, source)
    if path.stat().st_size > MAX_COMPRESSED_ARCHIVE:
        path.unlink()
        raise RuntimeError("compressed archive exceeds 8 MiB")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    with path.open("rb") as source:
        encoded = __import__("base64").b64encode(source.read()).decode("ascii")
    print("INTERLEAVE_ARCHIVE_BASE64=" + encoded, flush=True)
    return {"path": path.name, "sha256": digest, "compressedBytes": path.stat().st_size,
            "rawBytes": total, "files": len(members)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--rounds", type=int, default=15)
    parser.add_argument("--trial-timeout", type=int, default=180)
    parser.add_argument("--batch-timeout", type=int, default=1800)
    args = parser.parse_args()
    if args.rounds < 1 or args.trial_timeout < 1 or args.batch_timeout < 1:
        parser.error("rounds and timeout values must be positive")
    out = args.out.absolute()
    out.mkdir(mode=0o700, parents=True, exist_ok=False)
    os.chmod(out, 0o700)
    bun, taskset = shutil.which("bun"), shutil.which("taskset")
    if not bun or not taskset or not sys.platform.startswith("linux") or not hasattr(os, "sched_getaffinity"):
        raise RuntimeError("Linux, Bun, taskset, and sched_getaffinity are required")
    cpus = sorted(os.sched_getaffinity(0))
    if not cpus:
        raise RuntimeError("CPU affinity unavailable")
    cpu = cpus[0]
    head = subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", "HEAD"], text=True).strip()
    bun_version = subprocess.check_output([taskset, "-c", str(cpu), bun, "--version"], text=True, timeout=10).strip()
    if bun_version != "1.4.2":
        raise RuntimeError("expected Bun 1.4.2, found " + bun_version)
    dirty = bool(subprocess.check_output(["git", "-C", str(ROOT), "status", "--porcelain"], text=True).strip())
    started = time.monotonic()
    meta = {"schema": "agent-mem.interleave-diagnostic/v1", "head": head, "bun": bun_version,
            "selectedCpu": cpu, "allowedCpus": cpus, "schedule": "ABC/BCA/CAB repeated by round; serial",
            "rounds": args.rounds, "plannedTrials": args.rounds * 3, "workingTreeDirty": dirty,
            "trialTimeoutSeconds": args.trial_timeout,
            "batchTimeoutSeconds": args.batch_timeout, "arms": {k: {"files": v, "trace": k != "A"} for k, v in FILES.items()},
            "trials": [], "unsafe": False}
    (out / "trials").mkdir(mode=0o700)
    (out / "tmp").mkdir(mode=0o700)
    (out / "metadata.json").write_text(json.dumps(meta, indent=2) + "\n")
    stopped = False
    for round_no in range(1, args.rounds + 1):
        for arm in SCHEDULE[(round_no - 1) % 3]:
            if time.monotonic() - started >= args.batch_timeout:
                meta["stopReason"] = "batch timeout; remaining trials unattempted"
                stopped = True
                break
            ordinal = len(meta["trials"]) + 1
            trial_id = f"{ordinal:02d}-r{round_no:02d}-{arm}"
            trial_dir = out / "trials" / trial_id
            tmp = out / "tmp" / trial_id
            trial_dir.mkdir(mode=0o700)
            tmp.mkdir(mode=0o700)
            env = dict(os.environ)
            env.update({"TMPDIR": str(tmp), "TMP": str(tmp), "TEMP": str(tmp), "HOME": str(tmp),
                        "AMEM_INTERLEAVE_DIAGNOSTIC_DIR": str(trial_dir),
                        "AMEM_INTERLEAVE_DIAGNOSTIC_TRACE": "0" if arm == "A" else "1",
                        "NO_COLOR": "1", "FORCE_COLOR": "0"})
            command = [taskset, "-c", str(cpu), bun, "test", *FILES[arm]]
            before = process_receipt(tmp)
            log_path = out / "trials" / (trial_id + ".log")
            timeout = False
            t0 = time.monotonic()
            with log_path.open("wb") as log:
                process = subprocess.Popen(command, cwd=ROOT, env=env, stdout=subprocess.PIPE,
                                           stderr=subprocess.STDOUT, start_new_session=True)
                retained = 0
                selector = selectors.DefaultSelector()
                selector.register(process.stdout, selectors.EVENT_READ)
                while True:
                    remaining = min(args.trial_timeout - (time.monotonic() - t0), args.batch_timeout - (time.monotonic() - started))
                    if remaining <= 0:
                        timeout = True
                        break
                    ready = selector.select(min(0.2, remaining))
                    if ready:
                        chunk = os.read(process.stdout.fileno(), 16384)
                        if chunk:
                            keep = chunk[:max(0, MAX_LOG - retained)]
                            if keep:
                                log.write(keep)
                                retained += len(keep)
                        else:
                            selector.unregister(process.stdout)
                    if process.poll() is not None and not selector.get_map():
                        break
                selector.close()
                if timeout:
                    # The process group is this newly-created session and its leader is our live Popen.
                    if process.poll() is None:
                        os.killpg(process.pid, signal.SIGKILL)
                    # Never signal a group after leader exit; the receipt below records surviving owned descendants.
                    process.wait()
                else:
                    process.wait()
            elapsed = time.monotonic() - t0
            immediate = process_receipt(tmp)
            time.sleep(2)
            after = process_receipt(tmp)
            log_data = parse_log(log_path)
            trial = {"id": trial_id, "round": round_no, "arm": arm, "command": command[2:],
                     "exitCode": process.returncode, "outerTimeout": timeout, "wallSeconds": round(elapsed, 3),
                     **log_data, "snapshots": snapshot_evidence(trial_dir), "processesBefore": before,
                     "processesImmediatelyAfter": immediate, "processesAfter2s": after,
                     "temporaryReceipt": temp_receipt(tmp),
                     "logSha256": hashlib.sha256(log_path.read_bytes()).hexdigest()}
            trial["diagnosticComplete"] = (trial["summaryPresent"] and not trial["logTruncated"]
                and len(trial["snapshots"]) == 2 and all(not row.get("errors") and not row.get("truncated") for row in trial["snapshots"]))
            meta["trials"].append(trial)
            meta["unsafe"] |= any(p["state"] != "Z" for p in after) or timeout
            (out / "metadata.json").write_text(json.dumps(meta, indent=2) + "\n")
            print(json.dumps({"trial": trial_id, "arm": arm, "exitCode": process.returncode,
                              "outerTimeout": timeout, "summaryPresent": trial["summaryPresent"],
                              "failures": trial["failures"], "snapshots": trial["snapshots"]}, ensure_ascii=False), flush=True)
            if meta["unsafe"] or not trial["diagnosticComplete"]:
                meta["stopReason"] = "outer timeout, owned live survivor or incomplete diagnostic; halted before next trial"
                stopped = True
                break
        if stopped:
            break
    meta["completeSchedule"] = len(meta["trials"]) == args.rounds * 3
    meta.setdefault("stopReason", "all prespecified trials completed")
    meta["totalSeconds"] = round(time.monotonic() - started, 3)
    meta["counts"] = {arm: {"attempted": sum(t["arm"] == arm for t in meta["trials"]),
                            "failedInvocations": sum(t["arm"] == arm and t["exitCode"] != 0 for t in meta["trials"]),
                            "outerTimeouts": sum(t["arm"] == arm and t["outerTimeout"] for t in meta["trials"]),
                            "failureNames": dict(collections.Counter(f["name"] for t in meta["trials"] if t["arm"] == arm for f in t["failures"]))}
                   for arm in FILES}
    (out / "metadata.json").write_text(json.dumps(meta, indent=2) + "\n")
    print("INTERLEAVE_SUMMARY " + json.dumps({k: meta[k] for k in ("counts", "completeSchedule", "unsafe", "stopReason", "totalSeconds")} ), flush=True)
    try:
        meta["artifactSha256"] = {p.relative_to(out).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                                  for p in sorted(out.rglob("*")) if p.is_file() and not p.is_symlink() and p.name != "metadata.json"
                                  and p.relative_to(out).parts[0] != "tmp"}
        (out / "metadata.json").write_text(json.dumps(meta, indent=2) + "\n")
        meta["archive"] = archive(out)
        print("INTERLEAVE_ARCHIVE_RECEIPT " + json.dumps(meta["archive"]), flush=True)
        (out / "metadata.json").write_text(json.dumps(meta, indent=2) + "\n")
    except Exception as error:
        meta["archiveError"] = str(error)[:500]
        (out / "metadata.json").write_text(json.dumps(meta, indent=2) + "\n")
        return 1
    return 0 if meta["completeSchedule"] and not meta["unsafe"] and all(t["diagnosticComplete"] for t in meta["trials"]) else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print("diagnostic controller error: " + str(exc)[:500], file=sys.stderr)
        raise SystemExit(1)
