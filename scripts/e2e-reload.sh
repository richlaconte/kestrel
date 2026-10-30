#!/usr/bin/env bash
# E2E native hot-reload (#20, #21): run the fixture under `kestrel dev`, edit a
# file native.ts imports, and assert the open window's next call returns the
# new value. Usage: e2e-reload.sh   (run under xvfb-run in CI)
set -euo pipefail
. "$(dirname "$0")/e2e-lib.sh"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if command -v cygpath >/dev/null 2>&1; then REPO_ROOT="$(cygpath -m "$REPO_ROOT")"; fi
WORK="$(mktemp -d)"
DEV_PID=""
cleanup() {
  local rc=$?
  [ -n "$DEV_PID" ] && kill "$DEV_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  cd /
  rm_tree "$WORK"
  exit "$rc"
}
trap cleanup EXIT
cp -R "$REPO_ROOT/scripts/fixtures/reload/." "$WORK"
mkdir "$WORK/data"
KESTREL_DATA_DIR="$WORK/data"
command -v cygpath >/dev/null 2>&1 && KESTREL_DATA_DIR="$(cygpath -m "$WORK/data")"
export KESTREL_DATA_DIR
RESULT="$WORK/data/reload-result.json"

# wait_for <pattern> <seconds>: until the fixture's report matches.
wait_for() {
  for _ in $(seq $(($2 * 4))); do
    grep -q "$1" "$RESULT" 2>/dev/null && return 0
    kill -0 "$DEV_PID" 2>/dev/null || { echo "FAIL: kestrel dev exited early" >&2; exit 1; }
    sleep 0.25
  done
  echo "FAIL: no $1 in the report after $2s: $(cat "$RESULT" 2>/dev/null || echo '(none)')" >&2
  exit 1
}

cd "$WORK"
node "$REPO_ROOT/packages/kestrel/bin/kestrel.js" dev . --exit-after=40000 &
DEV_PID=$!

wait_for '"before"' 20
echo 'export const VALUE = "after";' > value.ts
wait_for '"after"' 10
grep -q '"seen":\["before","after"\]' "$RESULT" ||
  { echo "FAIL: expected one page to see before → after, got $(cat "$RESULT")" >&2; exit 1; }
echo "OK: $(cat "$RESULT") — reloaded without restarting the window"
