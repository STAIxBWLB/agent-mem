#!/usr/bin/env python3
"""Pure controller contract checks. Does not execute hooks or claim native proof."""
import argparse
import collections
import importlib.util
import json
from pathlib import Path
import tempfile
from unittest.mock import patch


def run_checks(controller):
    spec = importlib.util.spec_from_file_location("task127_controller", controller)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    checks = {}
    mac = module.schedule_for("macos")
    ubuntu = module.schedule_for("ubuntu")
    checks["mac-frozen-count"] = len(mac) == 50 and [item["ordinal"] for item in mac] == list(range(1, 51))
    checks["mac-equal-arm-exposure"] = collections.Counter(item["variant"] for item in mac) == {variant: 10 for variant in module.VARIANTS}
    checks["mac-latin-position-balance"] = all(collections.Counter(item["position"] for item in mac if item["variant"] == variant) == {position: 2 for position in range(1, 6)} for variant in module.VARIANTS)
    blocks = [[item["variant"] for item in mac if item["block"] == block] for block in range(1, 11)]
    checks["mac-pair-order-counterbalanced"] = sum(row.index("M") < row.index("H") for row in blocks) == 5
    checks["ubuntu-fixed-pairs"] = len(ubuntu) == 20 and all({item["variant"] for item in ubuntu if item["block"] == block} == {"M", "H"} for block in range(1, 11))
    checks["ubuntu-order-counterbalanced"] = sum(item["variant"] == "M" and item["position"] == 1 for item in ubuntu) == 5
    checks["ablation-paths"] = module.RESTORE == {"M": (), "P": ("src/hooks.ts", "src/hook-transcript.ts"), "PW": ("src/hook-transcript.ts",), "PU": ("src/hooks.ts",), "H": ()}
    good = '\n'.join(json.dumps(row) for row in [{"diagnostic": "transcript-budget-invocation", "metric": {"abandonedChildren": 0}}, {"diagnostic": "transcript-budget-sample", "event": "Stop", "logicalRun": 1}, {"diagnostic": "budget-group", "check": "transcript-hooks", "attempt": 1, "outcome": "pass"}])
    status = {"exitCode": 0, "cleanupOK": True, "timedOut": False}
    control = module.analyze(good, "", status)
    checks["synthetic-parser-positive"] = control["measurementValid"] and control["invocations"] == 1 and not control["failureClasses"]
    failed = module.analyze(good, "hook RSS provenance unknown; SQLITE_BUSY; transcript summaries not durable within 64", {**status, "exitCode": 1})
    checks["retained-native-failures-not-observer-corruption"] = failed["measurementValid"] and failed["scriptExitCode"] == 1 and set(failed["failureClasses"]) == {"rss-unknown", "harness-busy", "not-durable"}
    checks["malformed-diagnostic-blocks"] = not module.analyze(good + '\n{"diagnostic":oops', "", status)["measurementValid"]
    checks["overflow-blocks"] = not module.analyze(good + '\n' + json.dumps({"diagnostic": "task127-observer", "overflow": 1}), "", status)["measurementValid"]
    checks["r1-survivor-blocks"] = module.analyze(good + '\n' + json.dumps({"diagnostic": "transcript-R1", "survivors": 1}), "", status)["r1SurvivorOrMalformed"]
    checks["cleanup-unknown-blocks"] = not module.analyze(good, "", {**status, "cleanupOK": False})["measurementValid"]
    checks["observer-complete-unresolved-ownership-stops"] = module.observer_stop_reason({"observerComplete": True, "ownershipUnresolved": True}, 0) == "stable PID ownership unresolved after R1; subsequent scripts not executed"
    checks["observer-complete-known-ownership-continues"] = module.observer_stop_reason({"observerComplete": True, "ownershipUnresolved": False}, 0) is None
    checks["observer-corruption-distinct-from-lifecycle"] = module.observer_stop_reason({"observerComplete": False, "ownershipUnresolved": True}, 1) == "out-of-band observer analysis incomplete or invalid"
    fixture = {100: {"ppid": 1, "pgid": 100, "start": "stamp", "command": "bun harness"}, 101: {"ppid": 100, "pgid": 100, "start": "stamp", "command": "bun child"}, 102: {"ppid": 1, "pgid": 102, "start": "stamp", "command": "bun /unique/arm/src/session-brief-worker.ts"}, 999: {"ppid": 1, "pgid": 999, "start": "stamp", "command": "bun /other/src/session-brief-worker.ts"}}
    checks["owned-only-cleanup-selection"] = set(module.owned_processes(fixture, 100, Path("/unique/arm"))) == {101, 102}
    checks["pid-reuse-identity"] = module.identity(fixture[102]) != module.identity({**fixture[102], "start": "new"})
    checks["reaped-root-does-not-own-reused-pid-descendants"] = set(module.owned_processes(fixture, 100, Path("/unique/arm"), root_owned=False)) == {102}
    nested = {**fixture, 103: {"ppid": 102, "pgid": 102, "start": "stamp", "command": "bun grandchild"}}
    checks["detached-helper-descendants-included"] = set(module.owned_processes(nested, 100, Path("/unique/arm"))) == {101, 102, 103}
    checks["busy-observation-not-observer-fault"] = module.analyze(good + '\n' + json.dumps({"diagnostic": "task127-cursor-busy", "error": "SQLITE_BUSY"}), "", status)["measurementValid"]
    with tempfile.TemporaryDirectory(prefix="task127-controller-check-") as temporary:
        root = Path(temporary)
        (root / "source.ts").write_text("fixed")
        before = module.file_manifest(root)
        (root / "source.ts").write_text("changed")
        checks["source-mutation-detected"] = before != module.file_manifest(root)
        (root / "escape").symlink_to(root / "source.ts")
        try:
            module.file_manifest(root)
            checks["symlink-refused"] = False
        except RuntimeError:
            checks["symlink-refused"] = True
    return {"syntheticOnly": True, "checks": checks, "pass": all(checks.values())}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--controller", type=Path, default=Path(__file__).with_name("task-127-controller.py"))
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    report = run_checks(args.controller)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"controllerControlsPass": report["pass"], "checks": len(report["checks"])}))
    raise SystemExit(0 if report["pass"] else 1)
