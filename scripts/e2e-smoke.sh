#!/usr/bin/env bash
# E2E smoke test: kestrel create → kestrel dev (headless) → assert the app's
# native functions actually round-tripped (they persist kestrel-data.json).
# Usage: e2e-smoke.sh [react|vanilla]   (run under xvfb-run in CI)
set -euo pipefail

TEMPLATE="${1:-react}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KESTREL="node $REPO_ROOT/packages/kestrel/bin/kestrel.js"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
echo "== create ($TEMPLATE) =="
$KESTREL create smoke-app --template="$TEMPLATE"
cd smoke-app

if [ "$TEMPLATE" = "react" ]; then
  echo "== npm install =="
  npm install --silent
fi

echo "== dev (headless, self-exiting) =="
$KESTREL dev . --exit-after=15000

echo "== assert IPC persistence =="
if [ ! -f kestrel-data.json ]; then
  echo "FAIL: kestrel-data.json missing — native functions never ran" >&2
  exit 1
fi
grep -q '"visits"' kestrel-data.json
echo "OK: $(cat kestrel-data.json)"

if [ "$TEMPLATE" = "react" ]; then
  echo "== assert typegen output =="
  test -f native-client.ts
  grep -q "Promise<string>" native-client.ts
  echo "OK: typed stubs present"

  echo "== build (portable bundle) =="
  $KESTREL build .
  echo "== run bundle from a foreign cwd =="
  FOREIGN="$(mktemp -d)"
  ( cd "$FOREIGN" && KESTREL_EXIT_AFTER_MS=12000 "$OLDPWD/build/smoke-app/smoke-app" )
  test -f "$FOREIGN/kestrel-data.json" || { echo "FAIL: bundle IPC never ran" >&2; exit 1; }
  echo "OK: bundle ran from $FOREIGN — $(cat "$FOREIGN/kestrel-data.json")"
  rm -rf "$FOREIGN"
fi
