#!/usr/bin/env python3
"""Nonshipping task125 fixed-head native macOS acceptance controller. Never retries.

CLI: python3 acceptance20.py --repo PATH --head FULL_SHA --out NEW_OR_EMPTY_DIR
Import analyze(stdout, stderr, status) for parser controls without running commands.
Suggested controls: complete 120-workload fixture; mutate unknown RSS, NaN wall,
missing/duplicate call, incomplete summary, R1 survivor, advisory, second receipt,
timeout or nonzero status independently; every mutant must be ineligible.
Limitations: validates emitted receipts, not kernel stacks/process death times or
unlogged work. Source fingerprint covers declared tracked scopes, not OS state.
A controller pass is not repository preflight, CI approval or advisory retirement.
"""
import argparse
import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

COUNT = 20
TIMEOUT_SECONDS = 240
EVENTS = {"Stop": 3, "SessionEnd": 3, "StopBurst": 103}
RSS_KEYS = {"vmhwm", "vmpeakBound", "platformRusage", "rawFallback", "unavailable"}
SCOPES = ["src", "scripts", "test", "bin", "package.json", "bun.lock", "bun.lockb", ".bun-version", "tsconfig.json", "docs/bench/r2-baseline.json"]
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
ERROR_NEEDLES = ("hook RSS provenance unknown", "transcript summaries not durable within", "transcript budget scan progress unavailable", "transcript summary progress stalled", '"stopReason":"unavailable"', '"transcriptStopReason":"unavailable"')


def dump(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n")
    temporary.replace(path)


def finite(value, minimum=0):
    return type(value) in (int, float) and math.isfinite(value) and value >= minimum


def integer(value, minimum=0, maximum=None):
    return type(value) is int and value >= minimum and (maximum is None or value <= maximum)


def sources_known(value):
    return isinstance(value, dict) and set(value) == RSS_KEYS and all(integer(value[k], 0, 1024) for k in RSS_KEYS) and value["rawFallback"] == 0 and value["unavailable"] == 0 and sum(value[k] for k in ("vmhwm", "vmpeakBound", "platformRusage")) > 0


def objects(text):
    rows, malformed = [], []
    for number, original in enumerate(text.splitlines(), 1):
        line = ANSI.sub("", original).strip()
        # Production diagnostics are one complete JSON object per line. Pretty
        # final output and stack excerpts are deliberately not parsed as receipts.
        if not line.startswith("{"):
            continue
        try:
            value = json.loads(line)
        except (ValueError, json.JSONDecodeError):
            if line.startswith('{"diagnostic"'):
                malformed.append(number)
            continue
        if isinstance(value, dict) and "diagnostic" in value:
            rows.append((number, value))
    return rows, malformed


def _analyze(stdout, stderr, status):
    """Pure parser. status must describe the actual one-shot process result."""
    issues, records = [], []
    for name, text in (("stdout", stdout), ("stderr", stderr)):
        rows, malformed = objects(text)
        records.extend((name, line, value) for line, value in rows)
        if malformed:
            issues.append({"kind": "malformed-diagnostic", "stream": name, "lines": malformed})
    def fail(kind, **detail):
        issues.append({"kind": kind, **detail})
    if status.get("exitCode") != 0 or status.get("timedOut") or status.get("error") or not status.get("cleanupOK", True):
        fail("process-failed-or-partial", exitCode=status.get("exitCode"), timedOut=status.get("timedOut", False))
    for needle in ERROR_NEEDLES:
        if needle in stdout or needle in stderr:
            fail("reported-error", needle=needle)
    invocations = [(s, n, v) for s, n, v in records if v.get("diagnostic") == "transcript-budget-invocation"]
    samples = [(s, n, v) for s, n, v in records if v.get("diagnostic") == "transcript-budget-sample"]
    receipts = [v for _, _, v in records if v.get("diagnostic") == "budget-group" and v.get("check") == "transcript-hooks"]
    r1 = [v for _, _, v in records if v.get("diagnostic") == "transcript-R1"]
    r1_summaries = [v for _, _, v in records if v.get("diagnostic") == "transcript-R1-summary"]
    advisories = [v for _, _, v in records if v.get("diagnostic") == "transcript-budget-stall-advisory"]
    if advisories:
        fail("strict-stall-advisory", count=len(advisories))
    if any(str(v.get("diagnostic", "")).startswith(("task123", "task125-phase")) for _, _, v in records):
        fail("instrumented-diagnostics-present")
    if len(receipts) != 1 or type(receipts[0].get("attempt")) is not int or receipts[0].get("attempt") != 1 or receipts[0].get("outcome") != "pass":
        fail("not-one-first-attempt-pass", receipts=[{"attempt": v.get("attempt"), "outcome": v.get("outcome")} for v in receipts])
    def key(value):
        event, logical, follow = value.get("event"), value.get("logicalRun"), value.get("followUp")
        return (event, logical, follow) if event in EVENTS and integer(logical, 1, 40) and integer(follow, 0, 64) else None
    iv, sv = {}, {}
    walls, unknown, abandoned = [], 0, 0
    for stream, line, value in invocations:
        identity = key(value)
        if identity is None or identity in iv:
            fail("invalid-or-duplicate-invocation", stream=stream, line=line)
        else:
            iv[identity] = value
        metric = value.get("metric")
        if not isinstance(metric, dict):
            fail("missing-native-metric", stream=stream, line=line)
            continue
        wall = metric.get("wallMs")
        if not finite(wall) or wall > 300:
            fail("native-wall-invalid-or-over300", stream=stream, line=line, wallMs=wall if finite(wall) else None)
        else:
            walls.append(wall)
        known = sources_known(metric.get("rssSources")) and metric.get("rssScope") == "owned-images" and finite(metric.get("rssMB")) and 0 < metric["rssMB"] < 150
        if not known:
            unknown += 1
            fail("native-rss-invalid-unknown-or-ceiling", stream=stream, line=line)
        if value.get("exitCode") != 0 or value.get("stdoutBytes") != 0 or not finite(value.get("cliRssMB")) or value["cliRssMB"] <= 0:
            fail("native-cli-result-invalid", stream=stream, line=line)
        if metric.get("transcriptStopReason") == "unavailable":
            fail("native-scan-unavailable", stream=stream, line=line)
        count = metric.get("abandonedChildren", 0)
        if not integer(count):
            fail("invalid-abandoned-count", stream=stream, line=line)
        else:
            abandoned += count
    for stream, line, value in samples:
        identity = key(value)
        if identity is None or identity in sv:
            fail("invalid-or-duplicate-sample", stream=stream, line=line)
        else:
            sv[identity] = value
        if not sources_known(value.get("rssSources")) or not finite(value.get("rssMB")) or not 0 < value["rssMB"] < 150:
            fail("sample-rss-invalid", stream=stream, line=line)
        if value.get("stopReason") == "unavailable" or not integer(value.get("reasonOnlyStreak")) or value["reasonOnlyStreak"] >= 3:
            fail("sample-unavailable-or-strict-stall", stream=stream, line=line)
    if set(iv) != set(sv) or len(invocations) != len(samples):
        fail("sample-invocation-mismatch", invocations=len(invocations), samples=len(samples), missingSamples=len(set(iv)-set(sv)), missingInvocations=len(set(sv)-set(iv)))
    for identity in set(iv) & set(sv):
        metric, sample = iv[identity].get("metric"), sv[identity]
        if isinstance(metric, dict) and (sample.get("recordedRssMB") != metric.get("rssMB") or sample.get("rssSources") != metric.get("rssSources") or sample.get("rssMB") != max(metric.get("rssMB", 0), iv[identity].get("cliRssMB", 0))):
            fail("sample-native-telemetry-mismatch", event=identity[0], logicalRun=identity[1], followUp=identity[2])
    completion = {}
    for event, expected in EVENTS.items():
        complete = 0
        for logical in range(1, 41):
            workload = sorted((v for k, v in sv.items() if k[:2] == (event, logical)), key=lambda x: x["followUp"])
            if not workload:
                fail("missing-logical-workload", event=event, logicalRun=logical)
                continue
            if [v["followUp"] for v in workload] != list(range(len(workload))):
                fail("noncontiguous-followups", event=event, logicalRun=logical)
            previous_count, previous_offset, streak = 0, 0, 0
            for sample in workload:
                durable, new, offset = sample.get("durableSummaries"), sample.get("newSummaries"), sample.get("offset")
                if not integer(durable, 0, expected) or not integer(new) or durable - previous_count != new or not integer(offset) or not 0 <= offset - previous_offset <= 256 * 1024:
                    fail("invalid-progress-counters", event=event, logicalRun=logical, followUp=sample["followUp"])
                    break
                streak = 0 if new else streak + 1
                if streak >= 3 or sample.get("reasonOnlyStreak") != streak:
                    fail("strict-stall-or-streak-mismatch", event=event, logicalRun=logical, followUp=sample["followUp"])
                if previous_count == expected:
                    fail("call-after-workload-completed", event=event, logicalRun=logical)
                native = iv.get((event, logical, sample["followUp"]), {}).get("metric")
                if isinstance(native, dict) and native.get("transcriptOffset") is not None and native["transcriptOffset"] != offset:
                    fail("native-cursor-mismatch", event=event, logicalRun=logical)
                previous_count, previous_offset = durable, offset
            else:
                if previous_count == expected:
                    complete += 1
                else:
                    fail("incomplete-logical-workload", event=event, logicalRun=logical, durableSummaries=previous_count)
        completion[event] = complete
    if any(not integer(v.get("survivors")) or v.get("survivors") != 0 or not integer(v.get("aliveAtExit")) or not finite(v.get("postExitSurvivalMs")) for v in r1):
        fail("r1-survivor-or-invalid-observation")
    if len(r1_summaries) != 1:
        fail("missing-or-duplicate-r1-summary", count=len(r1_summaries))
    else:
        summary = r1_summaries[0]
        observed_alive = sum(v.get("aliveAtExit", 0) for v in r1 if integer(v.get("aliveAtExit")))
        observed_max = max((v["postExitSurvivalMs"] for v in r1 if integer(v.get("aliveAtExit"), 1) and finite(v.get("postExitSurvivalMs"))), default=0)
        if summary.get("windowMs") != 2000 or summary.get("invocations") != len(invocations) or summary.get("aliveAtExit") != observed_alive or summary.get("aliveAtExit") != abandoned or not finite(summary.get("maxSurvivalMs")) or abs(summary.get("maxSurvivalMs", 0) - observed_max) > 0.501:
            fail("r1-summary-mismatch")
    r1_keys = set()
    for observation in r1:
        identity = key(observation)
        if identity is None or identity in r1_keys or identity not in iv:
            fail("r1-invocation-identity-mismatch")
        else:
            r1_keys.add(identity)
            native = iv[identity].get("metric")
            if not isinstance(native, dict) or observation.get("aliveAtExit") != native.get("abandonedChildren", 0):
                fail("r1-native-abandoned-mismatch")
    if len(receipts) == 1 and isinstance(receipts[0].get("result"), dict):
        result = receipts[0]["result"]
        if result.get("samples") != [v for _, _, v in samples]:
            # Diagnostic records add only the diagnostic key to result samples.
            emitted = [{k: x for k, x in v.items() if k != "diagnostic"} for _, _, v in samples]
            if result.get("samples") != emitted:
                fail("receipt-samples-mismatch")
        groups = result.get("groups")
        if not isinstance(groups, list) or len(groups) != 3 or {g.get("event") for g in groups if isinstance(g, dict)} != set(EVENTS):
            fail("receipt-groups-invalid")
        else:
            for group in groups:
                event = group["event"]
                gate = group.get("rssGate", {})
                if group.get("logicalRuns") != 40 or group.get("runs") != sum(k[0] == event for k in sv) or group.get("wallPass") is not True or group.get("rssPass") is not True or gate.get("pass") is not True or any(gate.get(part, {}).get("pass") is not True for part in ("ceiling", "regression", "wallMax")):
                    fail("receipt-group-not-complete-pass", event=event)
                peaks = [max((x.get("rssMB", -1) for k, x in sv.items() if k[:2] == (event, logical)), default=-1) for logical in range(1, 41)]
                if any(not finite(x) or x <= 0 for x in peaks) or gate.get("runner") != "hosted-macos" or gate.get("regression", {}).get("p95MB") != sorted(peaks)[37]:
                    fail("receipt-p95-or-runner-mismatch", event=event)
    else:
        fail("missing-complete-group-result")
    return {"eligible": not issues, "issues": issues, "invocations": len(invocations), "samples": len(samples), "completeLogicalWorkloads": completion, "rssInvalidInvocations": unknown, "abandonedChildren": abandoned, "r1Observations": len(r1), "stallAdvisories": len(advisories), "maxKnownInBoundHandlerWallMs": max(walls, default=None), "receiptAttempts": [v.get("attempt") for v in receipts], "parserLimitations": ["One-line production diagnostics only; pretty final output is not a second receipt.", "Validates emitted telemetry and counters; does not establish kernel phase, exact death time, or unreported work.", "No external repository preflight or advisory-removal approval is inferred."]}


def analyze(stdout, stderr, status):
    """Malformed producer output never qualifies or prevents retaining later attempts."""
    try:
        return _analyze(stdout, stderr, status)
    except Exception as error:
        return {"eligible": False, "issues": [{"kind": "parser-shape-error", "error": str(error)}], "parserLimitations": ["Malformed/unexpected producer schemas fail closed; inspect retained raw logs."]}


def git(repo, *args):
    return subprocess.check_output(["git", "-C", str(repo), *args])


def fingerprint(repo, expected):
    head = git(repo, "rev-parse", "HEAD").decode().strip()
    if head != expected:
        raise RuntimeError("source head changed")
    subprocess.run(["git", "-C", str(repo), "diff", "--quiet", expected, "--", *SCOPES], check=True)
    digest = hashlib.sha256()
    for name in sorted(x for x in git(repo, "ls-files", "-z", "--", *SCOPES).split(b"\0") if x):
        digest.update(name + b"\0")
        with (repo / os.fsdecode(name)).open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        digest.update(b"\0")
    return {"head": head, "sha256": digest.hexdigest(), "scopes": SCOPES}


def guard_environment():
    forbidden = [k for k in os.environ if k == "BUN_OPTIONS" or k.startswith("AMEM_TASK123")]
    if forbidden:
        raise RuntimeError("instrumentation environment is present: " + ",".join(sorted(forbidden)))
    if sys.platform != "darwin" or os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("RUNNER_OS") != "macOS":
        raise RuntimeError("requires native hosted macOS GitHub Actions")
    version = subprocess.check_output(["bun", "--version"], text=True).strip()
    if version != "1.4.2":
        raise RuntimeError("Bun must be exactly 1.4.2")
    return version


def process_snapshot():
    text = subprocess.check_output(["ps", "-axo", "pid=,ppid=,lstart=,command="], text=True)
    rows = {}
    for line in text.splitlines():
        fields = line.strip().split(None, 7)
        if len(fields) >= 7 and fields[0].isdigit() and fields[1].isdigit():
            rows[int(fields[0])] = (int(fields[1]), " ".join(fields[2:7]), fields[7] if len(fields) > 7 else "")
    return rows


def cleanup_owned(process):
    """Own root group plus descendants captured before its kill, including detached helpers."""
    report = {"rootPid": process.pid, "groupSignal": None, "descendantSignals": [], "survivors": [], "observationAvailable": True}
    try:
        before = process_snapshot()
        owned, frontier = {}, {process.pid}
        while frontier:
            next_frontier = {pid for pid, row in before.items() if row[0] in frontier and pid != process.pid and pid not in owned}
            owned.update({pid: before[pid] for pid in next_frontier})
            frontier = next_frontier
    except (OSError, subprocess.SubprocessError):
        owned = {}
        report["observationAvailable"] = False
    try:
        os.killpg(process.pid, signal.SIGKILL)
        report["groupSignal"] = "sent"
    except ProcessLookupError:
        report["groupSignal"] = "already-gone"
    except OSError:
        report["groupSignal"] = "failed"
        report["observationAvailable"] = False
    for pid, identity in owned.items():
        try:
            current = process_snapshot().get(pid)
            if current is None or current[1:] != identity[1:]:
                continue
            os.kill(pid, signal.SIGKILL)
            report["descendantSignals"].append(pid)
        except ProcessLookupError:
            pass
        except (OSError, subprocess.SubprocessError):
            report["observationAvailable"] = False
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        report["survivors"].append(process.pid)
    try:
        after = process_snapshot()
        report["survivors"].extend(pid for pid, identity in owned.items() if pid in after and after[pid][1:] == identity[1:])
    except (OSError, subprocess.SubprocessError):
        report["observationAvailable"] = False
    report["ok"] = report["observationAvailable"] and not report["survivors"]
    return report


def run_once(repo, directory):
    command = ["bun", "scripts/measure-transcript-budget.ts"]
    start = time.monotonic()
    result = {"command": command, "timeoutSeconds": TIMEOUT_SECONDS, "timedOut": False, "cleanupOK": True}
    with (directory / "stdout.log").open("wb") as stdout, (directory / "stderr.log").open("wb") as stderr:
        process = subprocess.Popen(command, cwd=repo, stdout=stdout, stderr=stderr, start_new_session=True)
        result["executed"] = True
        try:
            process.wait(timeout=TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            result["timedOut"] = True
            result["cleanup"] = cleanup_owned(process)
            result["cleanupOK"] = result["cleanup"]["ok"]
        result["exitCode"] = process.returncode
    result["seconds"] = round(time.monotonic() - start, 3)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--head", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    repo, out = args.repo.resolve(), args.out.resolve()
    if not re.fullmatch(r"[0-9a-f]{40}", args.head):
        parser.error("--head requires a full lowercase40-character commit SHA")
    if out.exists() and any(out.iterdir()):
        parser.error("--out must be new or empty; retained attempts are never overwritten")
    out.mkdir(parents=True, exist_ok=True)
    preflight = {"expectedHead": args.head, "controllerSHA256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "timeoutSeconds": TIMEOUT_SECONDS, "requested": COUNT, "host": {k: os.environ.get(k) for k in ("CI", "GITHUB_ACTIONS", "RUNNER_OS")}}
    try:
        preflight["bun"] = guard_environment()
        preflight["source"] = fingerprint(repo, args.head)
        preflight["ok"] = True
    except Exception as error:
        preflight.update(ok=False, error=str(error))
    dump(out / "preflight.json", preflight)
    if not preflight["ok"]:
        dump(out / "summary.json", {"eligible": False, "measurementComplete": False, "requested": COUNT, "executed": 0, "preflight": preflight})
        return 1
    results, blocked = [], None
    for index in range(1, COUNT + 1):
        directory = out / ("iteration-%02d" % index)
        directory.mkdir()
        status = {"iteration": index, "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "executed": False}
        (directory / "stdout.log").touch()
        (directory / "stderr.log").touch()
        try:
            if blocked:
                raise RuntimeError("not executed after source/cleanup guard failed: " + blocked)
            guard_environment()
            status["sourceBefore"] = fingerprint(repo, args.head)
            if status["sourceBefore"] != preflight["source"]:
                raise RuntimeError("source fingerprint changed before attempt")
            status.update(run_once(repo, directory))
            status["sourceAfter"] = fingerprint(repo, args.head)
            guard_environment()
            if status["sourceAfter"] != preflight["source"]:
                raise RuntimeError("source fingerprint changed during attempt")
            if not status["cleanupOK"]:
                blocked = "owned process cleanup incomplete"
        except Exception as error:
            status["error"] = str(error)
            blocked = str(error)
        analysis = analyze((directory / "stdout.log").read_text(errors="replace"), (directory / "stderr.log").read_text(errors="replace"), status)
        analysis["eligible"] = analysis["eligible"] and status.get("sourceBefore") == preflight["source"] and status.get("sourceAfter") == preflight["source"] and status["executed"]
        if any(issue.get("kind") == "r1-survivor-or-invalid-observation" for issue in analysis["issues"]):
            blocked = "R1 survivor or invalid survival observation; no subsequent workload until ownership cleanup is established"
        dump(directory / "status.json", status)
        dump(directory / "analysis.json", analysis)
        results.append({"status": status, "analysis": analysis})
        print(json.dumps({"iteration": index, "exitCode": status.get("exitCode"), "eligible": analysis["eligible"], "issueCount": len(analysis["issues"])}), flush=True)
    executed = sum(r["status"]["executed"] for r in results)
    complete = executed == COUNT and all("sourceAfter" in r["status"] for r in results)
    summary = {"eligible": complete and all(r["analysis"]["eligible"] for r in results), "measurementComplete": complete, "requested": COUNT, "recorded": len(results), "executed": executed, "source": preflight["source"], "controllerSHA256": preflight["controllerSHA256"], "iterations": results, "note": "Twenty fixed sequential attempts, no retries or replacements. Partial/failed scripts never qualify. Separate valid repository preflight and owner/reviewer decision remain required; this controller never retires an advisory."}
    dump(out / "summary.json", summary)
    return 0 if summary["eligible"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
