#!/usr/bin/env bash
# E2E IPC contract: run the fixture app in the real host and assert what each
# kind of native function (sync, async, rejecting, never-settling, slow)
# returns to the webview. Usage: e2e-ipc.sh   (run under xvfb-run in CI)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${KESTREL_HOST:-$REPO_ROOT/host/target/release/kestrel-host}"
[ -x "$HOST" ] || HOST="$HOST.exe"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cp -R "$REPO_ROOT/scripts/fixtures/ipc/." "$WORK"

cd "$WORK"
KESTREL_EXIT_AFTER_MS=15000 "$HOST" kestrel.json
test -f ipc-results.json || { echo "FAIL: fixture never reported" >&2; exit 1; }
node "$REPO_ROOT/scripts/fixtures/ipc/assert.mjs" ipc-results.json
