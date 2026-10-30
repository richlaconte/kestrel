#!/usr/bin/env bash
# E2E webview std-lib (#17, #18): app, window, fs and store called straight
# from the webview through kestrel-native, with no native.ts. Runs the app
# twice (the store must survive a restart), checks app.quit() ends the host
# well before its safety timer, then runs it again without an fs grant.
# Usage: e2e-stdlib.sh   (run under xvfb-run in CI)
set -euo pipefail
. "$(dirname "$0")/e2e-lib.sh"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${KESTREL_HOST:-$REPO_ROOT/host/target/release/kestrel-host}"
[ -x "$HOST" ] || HOST="$HOST.exe"
WORK="$(mktemp -d)"
trap 'rc=$?; cd /; rm_tree "$WORK"; exit $rc' EXIT
cp -R "$REPO_ROOT/scripts/fixtures/stdlib/." "$WORK"
cp "$REPO_ROOT/packages/kestrel-native/index.js" "$WORK/kestrel-native.js"
cd "$WORK"
native_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi; }

run() { # run <granted|ungranted> <run number>
  local perms='["fs:app-data"]'
  [ "$1" = ungranted ] && perms='[]'
  printf '{"appId":"kestrel-e2e-stdlib-%s","title":"Std-lib","version":"1.2.3","frontend":".","permissions":%s}\n' \
    "$1" "$perms" > "$1.kestrel.json"
  mkdir -p "data-$1"
  local t0=$SECONDS
  KESTREL_DATA_DIR="$(native_path "$WORK/data-$1")" KESTREL_EXIT_AFTER_MS=30000 "$HOST" "$1.kestrel.json"
  [ $((SECONDS - t0)) -lt 25 ] || { echo "FAIL: app.quit() didn't end the host" >&2; exit 1; }
  local result="data-$1/stdlib-result.json"
  if [ "$1" = ungranted ]; then
    # No fs grant: the fixture reported through the store; read it back.
    node -e 'const s=require(process.argv[1]); require("fs").writeFileSync(process.argv[2], JSON.stringify(s.result))' \
      "$(native_path "$WORK/data-$1/.kestrel/store.json")" "$result"
  fi
  node assert.mjs "$1" "$result" "$2"
}

run granted 1
run granted 2
run ungranted 1
echo "OK: std-lib works from the webview, the store persists, fs is gated"
