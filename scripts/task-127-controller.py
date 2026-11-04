#!/usr/bin/env python3
"""Disposable task127 paired diagnostics. No acceptance verdict, retries or replacements.

Source variants are exact git archives; preload instrumentation never writes their
source. Every scheduled script, raw failure, observer limitation and cleanup result
is retained. Missing/partial observations cannot become successful measurements.
"""
import argparse
import collections
import datetime
import hashlib
import io
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tarfile
import time

MAIN = "0d15f5354773dbaa966cf4f75cd3a7890e87d0ff"
HEAD = "cdd196666e7efab2f7ec04c654a1bcfa8fd49517"
VARIANTS = ("M", "P", "PW", "PU", "H")
RESTORE = {"M": (), "P": ("src/hooks.ts", "src/hook-transcript.ts"), "PW": ("src/hook-transcript.ts",), "PU": ("src/hooks.ts",), "H": ()}
SOURCE_CHANGES = {"src/hooks.ts", "src/hook-transcript.ts", "src/hook-spool.ts"}
TIMEOUT_SECONDS = 240
RUN_BUDGET_SECONDS = 105 * 60
FINISH_RESERVE_SECONDS = 300
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


def dump(file, value):
    temporary = file.with_suffix(file.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n")
    temporary.replace(file)


def digest_bytes(value):
    return hashlib.sha256(value).hexdigest()


def file_manifest(root):
    """All archive bytes, including non-source files; no node_modules or git tree."""
    result = {}
    for file in sorted(root.rglob("*")):
        relative = file.relative_to(root)
        if any(part in {"node_modules", ".git"} for part in relative.parts):
            continue
        if file.is_symlink():
            raise RuntimeError("unexpected symlink in frozen archive: " + str(relative))
        if file.is_file():
            result[str(relative)] = digest_bytes(file.read_bytes())
    return result


def manifest_hash(value):
    return digest_bytes(json.dumps(value, sort_keys=True, separators=(",", ":")).encode())


def can_start_attempt(started, current):
    # Keep the fixed schedule, but retain unexecuted slots before the120-minute
    # job deadline so artifact upload has time to preserve every attempted result.
    return current - started < RUN_BUDGET_SECONDS - FINISH_RESERVE_SECONDS


def schedule_for(platform):
    if platform == "macos":
        # Two Latin squares, with the second reversed: each arm occupies every
        # position twice, and M-before-H / H-before-M is exactly five blocks each.
        first = [[VARIANTS[(index + shift) % 5] for index in (0, 1, 4, 2, 3)] for shift in range(5)]
        orders = first + [list(reversed(row)) for row in first]
    elif platform == "ubuntu":
        orders = [["M", "H"] if block % 2 == 0 else ["H", "M"] for block in range(10)]
    else:
        raise ValueError("platform must be macos or ubuntu")
    return [{"ordinal": ordinal + 1, "block": block + 1, "position": position + 1, "variant": variant}
            for ordinal, (block, position, variant) in enumerate((b, p, v) for b, row in enumerate(orders) for p, v in enumerate(row))]


def git(repo, *args):
    return subprocess.check_output(["git", "-C", str(repo), *args])


def export_archive(repo, commit, target):
    target.mkdir(parents=True)
    raw = git(repo, "archive", "--format=tar", commit)
    with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
        for member in archive.getmembers():
            name = Path(member.name)
            if name.is_absolute() or ".." in name.parts or not (member.isdir() or member.isfile()):
                raise RuntimeError("archive member is not a regular frozen input: " + member.name)
            destination = target / name
            if member.isdir():
                destination.mkdir(parents=True, exist_ok=True)
            else:
                destination.parent.mkdir(parents=True, exist_ok=True)
                stream = archive.extractfile(member)
                if stream is None:
                    raise RuntimeError("missing archive bytes: " + member.name)
                destination.write_bytes(stream.read())
                destination.chmod(member.mode & 0o777)


def build_variants(repo, directory, variants):
    if git(repo, "rev-parse", MAIN).decode().strip() != MAIN or git(repo, "rev-parse", HEAD).decode().strip() != HEAD:
        raise RuntimeError("frozen source refs are unavailable")
    changes = set(git(repo, "diff", "--name-only", MAIN, HEAD, "--", "src").decode().splitlines())
    if changes != SOURCE_CHANGES:
        raise RuntimeError("unexpected production diff between frozen refs: " + repr(sorted(changes)))
    # The measured harness and fixture must have identical source across arms.
    for name in ("scripts/measure-transcript-budget.ts", "test/fakes/hooks-fixture.ts"):
        if git(repo, "show", MAIN + ":" + name) != git(repo, "show", HEAD + ":" + name):
            raise RuntimeError("harness differs across frozen refs: " + name)
    records = {}
    main_src = {name: git(repo, "show", MAIN + ":" + name) for name in SOURCE_CHANGES}
    head_src = {name: git(repo, "show", HEAD + ":" + name) for name in SOURCE_CHANGES}
    for variant in variants:
        target = directory / variant
        commit = MAIN if variant == "M" else HEAD
        export_archive(repo, commit, target)
        patches = []
        for name in RESTORE[variant]:
            before = (target / name).read_bytes()
            after = main_src[name]
            (target / name).write_bytes(after)
            patches.append({"path": name, "fromSHA256": digest_bytes(before), "toSHA256": digest_bytes(after), "sourceCommit": MAIN})
        expected = {name: (main_src[name] if variant == "M" or name in RESTORE[variant] else head_src[name]) for name in SOURCE_CHANGES}
        if any((target / name).read_bytes() != content for name, content in expected.items()):
            raise RuntimeError("variant construction differs from declared source: " + variant)
        manifest = file_manifest(target)
        records[variant] = {"archiveCommit": commit, "tree": git(repo, "rev-parse", commit + "^{tree}").decode().strip(), "restored": patches,
                            "manifest": manifest, "sha256": manifest_hash(manifest), "sourceDiffFromMain": sorted(name for name in SOURCE_CHANGES if (target / name).read_bytes() != main_src[name])}
    return records


def diagnostic_inputs(instrument):
    files = {Path(__file__).resolve(), instrument.resolve()}
    files.update(instrument.parent.glob("task-127-*.ts"))
    files.update(instrument.parent.glob("task-127-*.c"))
    return {str(file): digest_bytes(file.read_bytes()) for file in sorted(files)}


def guard_environment(platform):
    forbidden = [key for key in os.environ if key == "BUN_OPTIONS" or key.startswith("AMEM_TASK123")]
    if forbidden:
        raise RuntimeError("ambient instrumentation environment present: " + ",".join(sorted(forbidden)))
    expected = {"macos": ("darwin", "macOS"), "ubuntu": ("linux", "Linux")}[platform]
    if sys.platform != expected[0] or os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("RUNNER_OS") != expected[1]:
        raise RuntimeError("requires the declared native GitHub Actions runner")
    version = subprocess.check_output(["bun", "--version"], text=True).strip()
    if version != "1.4.2":
        raise RuntimeError("requires pinned Bun1.4.2")
    return {"bun": version, "platform": sys.platform, "markers": {key: os.environ.get(key) for key in ("GITHUB_ACTIONS", "RUNNER_OS", "ImageOS", "ImageVersion")}}


def process_snapshot():
    output = subprocess.check_output(["ps", "-axo", "pid=,ppid=,pgid=,lstart=,command="], text=True)
    result = {}
    for line in output.splitlines():
        fields = line.strip().split(None, 8)
        if len(fields) < 9 or any(not fields[index].isdigit() for index in range(3)):
            continue
        result[int(fields[0])] = {"ppid": int(fields[1]), "pgid": int(fields[2]), "start": " ".join(fields[3:8]), "command": fields[8]}
    return result


def identity(row):
    return row["start"], row["command"]


def owned_processes(snapshot, root_pid, arm, root_owned=True):
    # Unique disposable arm paths bind detached or reparented worker candidates.
    # No process outside this experiment's path or captured descendant tree is signalled.
    owned = {pid: row for pid, row in snapshot.items() if str(arm) in row["command"] and ("session-brief-worker.ts" in row["command"] or "measure-transcript-budget.ts" in row["command"])}
    visited = set()
    frontier = set(owned)
    if root_owned:
        frontier.add(root_pid)
    while frontier:
        visited.update(frontier)
        new = {pid for pid, row in snapshot.items() if row["ppid"] in frontier and pid not in visited}
        owned.update({pid: snapshot[pid] for pid in new})
        frontier = new
    return owned


def cleanup_owned(process, arm):
    report = {"rootPid": process.pid, "observationAvailable": True, "groupSignal": None, "descendantSignals": [], "survivors": []}
    try:
        before = process_snapshot()
        root_live = process.poll() is None
        owned = owned_processes(before, process.pid, arm, root_owned=root_live)
    except (OSError, subprocess.SubprocessError):
        report["observationAvailable"] = False
        owned = {}
        root_live = process.poll() is None
    try:
        # A reaped root PID may have been reused. Signal its old group only if
        # the root is still our unreaped child or a captured owned member holds it.
        group_owned = root_live or any(row["pgid"] == process.pid for row in owned.values())
        if group_owned:
            os.killpg(process.pid, signal.SIGKILL)
            report["groupSignal"] = "sent"
        else:
            report["groupSignal"] = "not-owned-now"
    except ProcessLookupError:
        report["groupSignal"] = "already-gone"
    except OSError:
        report["groupSignal"] = "failed"
        report["observationAvailable"] = False
    for pid, original in owned.items():
        try:
            current = process_snapshot().get(pid)
            if current is not None and identity(current) == identity(original):
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
        report["survivors"].extend(pid for pid, original in owned.items() if pid in after and identity(after[pid]) == identity(original))
        # Also catch a known helper reparented between the earlier snapshots.
        report["survivors"].extend(pid for pid in owned_processes(after, process.pid, arm, root_owned=process.poll() is None) if pid not in report["survivors"])
    except (OSError, subprocess.SubprocessError):
        report["observationAvailable"] = False
    report["ok"] = report["observationAvailable"] and not report["survivors"]
    return report


def objects(stdout, stderr):
    result, malformed = [], []
    for stream, value in (("stdout", stdout), ("stderr", stderr)):
        for number, original in enumerate(value.splitlines(), 1):
            line = ANSI.sub("", original).strip()
            if not line.startswith('{"diagnostic"'):
                continue
            try:
                row = json.loads(line)
            except ValueError:
                malformed.append({"stream": stream, "line": number})
                continue
            if isinstance(row, dict):
                result.append(row)
    return result, malformed


def analyze(stdout, stderr, status):
    rows, malformed = objects(stdout, stderr)
    invocations = [row for row in rows if row.get("diagnostic") == "transcript-budget-invocation"]
    samples = [row for row in rows if row.get("diagnostic") == "transcript-budget-sample"]
    advisories = [row for row in rows if row.get("diagnostic") == "transcript-budget-stall-advisory"]
    receipts = [row for row in rows if row.get("diagnostic") == "budget-group" and row.get("check") == "transcript-hooks"]
    r1 = [row for row in rows if row.get("diagnostic") == "transcript-R1"]
    diagnostic_rows = [row for row in rows if str(row.get("diagnostic", "")).startswith("task127")]
    ownership_unresolved = any(row.get("diagnostic") == "task127-ownership-unresolved" and row.get("ownershipUnresolved") is True for row in diagnostic_rows)
    classes = []
    text = stdout + "\n" + stderr
    for needle, label in (("hook RSS provenance unknown", "rss-unknown"), ("transcript summaries not durable within", "not-durable"), ("transcript budget scan progress unavailable", "scan-unavailable"), ("transcript summary progress stalled", "strict-stall"), ("SQLITE_BUSY", "harness-busy"), ("database is locked", "harness-busy")):
        if needle in text and label not in classes:
            classes.append(label)
    if any(row.get("outcome") == "wall-max-miss" for row in receipts):
        classes.append("wall-max-miss")
    survivors = any(type(row.get("survivors")) is int and row["survivors"] > 0 for row in r1)
    malformed_r1 = [row for row in r1 if type(row.get("survivors")) is not int or row["survivors"] < 0]
    observer_errors = [row for row in diagnostic_rows if row.get("overflow") or row.get("observerComplete") is False or (row.get("diagnostic") == "task127-observer-error")]
    metrics = [row.get("metric") for row in invocations if isinstance(row.get("metric"), dict)]
    return {"scriptExitCode": status.get("exitCode"), "scriptOutcomes": [{key: row.get(key) for key in ("attempt", "outcome", "error", "slow", "before", "after")} for row in receipts],
            "failureClasses": classes, "invocations": len(invocations), "samples": len(samples), "advisoryRows": len(advisories),
            "advisoryWorkloads": len({json.dumps([row.get("event"), row.get("logicalRun")], sort_keys=True) for row in advisories}),
            "abandonedChildren": sum(row.get("abandonedChildren", 0) for row in metrics if type(row.get("abandonedChildren", 0)) is int),
            "r1Survivor": survivors, "r1Malformed": malformed_r1, "r1SurvivorOrMalformed": survivors or bool(malformed_r1),
            "ownershipUnresolved": ownership_unresolved,
            "malformedDiagnostics": malformed, "observerErrors": observer_errors,
            "diagnosticRows": len(diagnostic_rows),
            "diagnosticComplete": not malformed and not malformed_r1 and not observer_errors and not status.get("timedOut") and not status.get("error") and status.get("cleanupOK") is True,
            "measurementValid": not malformed and not malformed_r1 and not observer_errors and not status.get("timedOut") and not status.get("error") and status.get("cleanupOK") is True,
            "note": "Instrumented source diagnostics only; neither script success nor complete diagnostics is product acceptance or causal attribution."}


def observer_stop_reason(observer, exit_code=None):
    """Only ownership evidence stops the fixed schedule, not observer completeness."""
    if observer.get("ownershipUnresolved") is True:
        return "stable PID ownership unresolved after R1; subsequent scripts not executed"
    return None


def observer_diagnostic_complete(observer, exit_code):
    return exit_code == 0 and observer.get("observerComplete") is True and not observer.get("error")


def first_stop(blocked, reason):
    return blocked if blocked is not None else str(reason) or "unspecified safety/source guard failure"


def safety_stop_reason(status, analysis):
    if status.get("executed") and status.get("cleanupOK") is not True:
        return "owned process cleanup unavailable or owned worker remained"
    if analysis.get("r1Survivor"):
        return "R1 survivor after the fixed observation window; subsequent scripts not executed"
    if analysis.get("ownershipUnresolved") is True:
        return "stable PID ownership unresolved after R1; subsequent scripts not executed"
    return None


def completeness(iterations, requested, blocked):
    schedule_complete = len(iterations) == requested and blocked is None and all(row["status"].get("attempted") for row in iterations)
    diagnostic_complete = schedule_complete and all(row["analysis"].get("diagnosticComplete") and "sourceAfter" in row["status"] for row in iterations)
    return {"scheduleComplete": bool(schedule_complete), "diagnosticComplete": bool(diagnostic_complete),
            "measurementComplete": bool(diagnostic_complete)}


def run_once(arm, preload, attempt, item):
    env = os.environ.copy()
    trace = attempt / "trace"
    trace.mkdir()
    env.update(AMEM_TASK127_TRACE_DIR=str(trace), AMEM_TASK127_VARIANT=item["variant"], AMEM_TASK127_BLOCK=str(item["block"]), AMEM_TASK127_ATTEMPT=str(item["ordinal"]))
    command = ["bun", "--preload", str(preload), str(arm / "scripts/measure-transcript-budget.ts")]
    result = {"command": command, "timeoutSeconds": TIMEOUT_SECONDS, "timedOut": False, "cleanupOK": True, "executed": False}
    started = time.monotonic()
    with (attempt / "stdout.log").open("wb") as stdout, (attempt / "stderr.log").open("wb") as stderr:
        process = subprocess.Popen(command, cwd=arm, env=env, stdout=stdout, stderr=stderr, start_new_session=True)
        result.update(attempted=True, executed=True, pid=process.pid)
        dump(attempt / "status.json", {**item, **result, "state": "running"})
        try:
            process.wait(timeout=TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            result["timedOut"] = True
            result["cleanup"] = cleanup_owned(process, arm)
            result["cleanupOK"] = result["cleanup"]["ok"]
        result["exitCode"] = process.returncode
    try:
        remaining = owned_processes(process_snapshot(), process.pid, arm, root_owned=False)
        result["remainingOwnedProcesses"] = [{"pid": pid, **row} for pid, row in remaining.items()]
        if remaining:
            result["cleanup"] = cleanup_owned(process, arm)
            # A timeout/aborted observer may leave a verified owned helper. Continue
            # only when explicit cleanup establishes its disappearance; R1 survivor
            # and same-window PID ownership verdicts remain separate stop guards.
            result["cleanupOK"] = result["cleanup"]["ok"]
    except (OSError, subprocess.SubprocessError) as error:
        result.update(cleanupOK=False, cleanupObservationError=str(error))
    result["seconds"] = round(time.monotonic() - started, 3)
    result["traceFiles"] = sum(file.is_file() for file in trace.rglob("*"))
    return result


def main():
    run_started = time.monotonic()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--instrument", type=Path, required=True)
    parser.add_argument("--platform", choices=("macos", "ubuntu"), required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    repo, out, instrument = args.repo.resolve(), args.out.resolve(), args.instrument.resolve()
    if out.exists() and any(out.iterdir()):
        parser.error("--out must be new or empty; no retained result may be overwritten")
    out.mkdir(parents=True, exist_ok=True)
    schedule = schedule_for(args.platform)
    dump(out / "schedule.json", {"platform": args.platform, "main": MAIN, "head": HEAD, "blocks": 10, "scripts": len(schedule), "schedule": schedule, "sha256": manifest_hash(schedule)})
    summary = {"schema": "task127-diagnostics/v2", "diagnosticOnly": True, "scheduleComplete": False, "diagnosticComplete": False, "measurementComplete": False, "requested": len(schedule), "attempted": 0, "executed": 0, "iterations": [], "acceptanceClaim": False,
               "runBudgetSeconds": RUN_BUDGET_SECONDS, "finishReserveSeconds": FINISH_RESERVE_SECONDS}
    dump(out / "summary.json", summary)
    preflight = {"main": MAIN, "head": HEAD, "controller": diagnostic_inputs(instrument), "scheduleSHA256": manifest_hash(schedule)}
    try:
        preflight["runtime"] = guard_environment(args.platform)
        selected = VARIANTS if args.platform == "macos" else ("M", "H")
        variants = build_variants(repo, out / "variants", selected)
        preflight["variants"] = variants
        diagnostic_dir = out / "instrumentation"
        diagnostic_dir.mkdir()
        for variant in selected:
            target = diagnostic_dir / variant
            install_command = ["bun", str(instrument), "--repo", str(out / "variants" / variant), "--out", str(target)]
            shared_probe = diagnostic_dir / selected[0] / "task-127-fgetlk"
            if args.platform == "macos" and variant != selected[0]:
                if not shared_probe.is_file():
                    raise RuntimeError("shared prebuilt native lock probe missing")
                install_command.extend(["--probe-binary", str(shared_probe)])
            with (out / ("install-" + variant + ".stdout.log")).open("wb") as stdout, (out / ("install-" + variant + ".stderr.log")).open("wb") as stderr:
                subprocess.run(install_command, check=True, stdout=stdout, stderr=stderr)
            if not (target / "preload.ts").is_file() or not (target / "instrumentation.json").is_file():
                raise RuntimeError("instrumenter did not produce required files for " + variant)
            if file_manifest(out / "variants" / variant) != variants[variant]["manifest"]:
                raise RuntimeError("instrumenter changed frozen source bytes for " + variant)
        preflight["instrumentation"] = file_manifest(diagnostic_dir)
        if args.platform == "macos":
            probes = {variant: digest_bytes((diagnostic_dir / variant / "task-127-fgetlk").read_bytes()) for variant in selected}
            if len(set(probes.values())) != 1:
                raise RuntimeError("native lock observer bytes differ between matched arms")
            preflight["nativeProbeSHA256"] = probes
        preflight["ok"] = True
    except Exception as error:
        preflight.update(ok=False, error=str(error))
    dump(out / "preflight.json", preflight)
    if not preflight["ok"]:
        summary["preflightError"] = preflight.get("error")
        dump(out / "summary.json", summary)
        return 1
    blocked = None
    for item in schedule:
        attempt = out / ("attempt-%02d-block-%02d-%s" % (item["ordinal"], item["block"], item["variant"]))
        attempt.mkdir()
        (attempt / "stdout.log").touch()
        (attempt / "stderr.log").touch()
        status = {**item, "attempted": False, "executed": False, "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}
        if blocked is not None:
            status.update(error="not executed after a prior safety/source guard", blockedBy=blocked)
        else:
            try:
                if not can_start_attempt(run_started, time.monotonic()):
                    raise RuntimeError("declared diagnostic run budget exhausted; remaining slots retained unexecuted for artifact upload")
                guard_environment(args.platform)
                arm = out / "variants" / item["variant"]
                expected = variants[item["variant"]]["manifest"]
                if file_manifest(arm) != expected or diagnostic_inputs(instrument) != preflight["controller"] or file_manifest(diagnostic_dir) != preflight["instrumentation"]:
                    raise RuntimeError("frozen source/controller/instrumentation changed before attempt")
                status["sourceBefore"] = variants[item["variant"]]["sha256"]
                status["attempted"] = True
                status.update(run_once(arm, diagnostic_dir / item["variant"] / "preload.ts", attempt, item))
                if file_manifest(arm) != expected or diagnostic_inputs(instrument) != preflight["controller"] or file_manifest(diagnostic_dir) != preflight["instrumentation"]:
                    raise RuntimeError("frozen source/controller/instrumentation changed during attempt")
                status["sourceAfter"] = variants[item["variant"]]["sha256"]
            except Exception as error:
                status["error"] = str(error)
                # Execution/provenance errors outside the observer analyzer cannot
                # establish safe ownership/source state for the next scheduled slot.
                blocked = first_stop(blocked, error)
        try:
            analysis = analyze((attempt / "stdout.log").read_text(errors="replace"), (attempt / "stderr.log").read_text(errors="replace"), status)
        except Exception as error:
            analysis = {"diagnosticComplete": False, "measurementValid": False, "parserError": str(error), "failureClasses": [], "advisoryRows": None, "r1Survivor": False}
        safety_reason = safety_stop_reason(status, analysis)
        if safety_reason:
            blocked = first_stop(blocked, safety_reason)
        if status.get("executed"):
            try:
                with (attempt / "observer.stdout.log").open("wb") as stdout, (attempt / "observer.stderr.log").open("wb") as stderr:
                    observed = subprocess.run(["bun", str(instrument), "--analyze", str(attempt / "trace"), "--stdout", str(attempt / "stdout.log"), "--out", str(attempt / "observer-analysis.json")], stdout=stdout, stderr=stderr, timeout=30)
                observer = json.loads((attempt / "observer-analysis.json").read_text())
                analysis["observer"] = {"exitCode": observed.returncode, **observer}
                analysis["diagnosticComplete"] = analysis["diagnosticComplete"] and observer_diagnostic_complete(observer, observed.returncode)
                observer_reason = observer_stop_reason(observer, observed.returncode)
                if observer_reason:
                    blocked = first_stop(blocked, observer_reason)
            except Exception as error:
                analysis["diagnosticComplete"] = False
                analysis["observerAnalysisError"] = str(error)
        if status.get("executed") and status.get("traceFiles", 0) == 0:
            analysis["diagnosticComplete"] = False
            analysis["traceUnavailable"] = True
        analysis["measurementValid"] = analysis["diagnosticComplete"]
        dump(attempt / "status.json", status)
        dump(attempt / "analysis.json", analysis)
        summary["iterations"].append({"status": status, "analysis": analysis})
        summary["attempted"] = sum(row["status"].get("attempted", False) for row in summary["iterations"])
        summary["executed"] = sum(row["status"].get("executed", False) for row in summary["iterations"])
        summary["blocked"] = blocked
        summary.update(completeness(summary["iterations"], len(schedule), blocked))
        dump(out / "summary.json", summary)
        print(json.dumps({**item, "executed": status["executed"], "exitCode": status.get("exitCode"), "failureClasses": analysis["failureClasses"], "advisoryRows": analysis["advisoryRows"], "blocked": blocked}), flush=True)
    summary.update(completeness(summary["iterations"], len(schedule), blocked))
    summary["note"] = "Every fixed scheduled result retained, no retries/replacements. Observer incompleteness does not stop the schedule; ownership/safety/source guards do. Schedule completion and diagnostic completeness are separate and never product acceptance."
    dump(out / "summary.json", summary)
    return 0 if summary["measurementComplete"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
