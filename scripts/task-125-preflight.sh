#!/usr/bin/env bash
# Nonshipping fixed-head gate. All logs survive a failed command; no retry.
set -euo pipefail
probe_repo=$1
probe_head=$2
probe_out=$3
mkdir -p "$probe_out"
cd "$probe_repo"
[[ "$(git rev-parse HEAD)" == "$probe_head" ]]
[[ "$(bun --version)" == 1.4.2 ]]
probe_run() {
  local probe_label=$1
  shift
  set +e
  "$@" > "$probe_out/$probe_label.stdout.log" 2> "$probe_out/$probe_label.stderr.log"
  local probe_code=$?
  set -e
  echo "$probe_code" > "$probe_out/$probe_label.exit"
  echo "$probe_label: $probe_code"
  return "$probe_code"
}
probe_run install bun install --frozen-lockfile
probe_run typecheck bun x tsc --noEmit
probe_run boundary bun scripts/check-boundary.ts
probe_run tests bun test --timeout 20000
probe_run pack npm pack --dry-run
probe_run resolve-previous bun scripts/previous-release.ts "$RUNNER_TEMP/task125-previous"
IFS=$'\t' read -r probe_previous_version probe_previous_root < "$probe_out/resolve-previous.stdout.log"
echo "$probe_previous_version" > "$probe_out/previous-version.txt"
probe_run previous-tests env AMEM_PREV_REQUIRED=1 AMEM_PREV_ROOT="$probe_previous_root" bun test test/previous-release.test.ts
echo 0 > "$probe_out/complete.exit"
