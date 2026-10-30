#!/usr/bin/env bash
# E2E webview std-lib (#17, #18): app, window, fs, store, clipboard, and the
# permission gates on dialog, notify and shell, called straight
# from the webview through kestrel-native, with no native.ts. Runs the app
# twice (the store must survive a restart), checks app.quit() ends the host
# well before its safety timer (150 s), then runs it again without an fs grant.
# Usage: e2e-stdlib.sh   (run under xvfb-run in CI)
set -euo pipefail
. "$(dirname "$0")/e2e-lib.sh"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${KESTREL_HOST:-$REPO_ROOT/host/target/release/kestrel-host}"
[ -x "$HOST" ] || HOST="$HOST.exe"
WORK="$(mktemp -d)"
# The fixture writes the clipboard; put a developer's clipboard back after.
SAVED_CLIP=""
[ "$(uname)" = Darwin ] && SAVED_CLIP="$(pbpaste 2>/dev/null || true)"
trap 'rc=$?; [ "$(uname)" = Darwin ] && printf %s "$SAVED_CLIP" | pbcopy; cd /; rm_tree "$WORK"; exit $rc' EXIT
cp -R "$REPO_ROOT/scripts/fixtures/stdlib/." "$WORK"
cp "$REPO_ROOT/packages/kestrel-native/index.js" "$WORK/kestrel-native.js"
cd "$WORK"
native_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi; }

run() { # run <granted|ungranted> <run number>
  local perms='["fs:app-data","clipboard","shell:open"]'
  [ "$1" = ungranted ] && perms='[]'
  printf '{"appId":"kestrel-e2e-stdlib-%s","title":"Std-lib","version":"1.2.3","frontend":".","permissions":%s}\n' \
    "$1" "$perms" > "$1.kestrel.json"
  mkdir -p "data-$1"
  local t0=$SECONDS
  KESTREL_DATA_DIR="$(native_path "$WORK/data-$1")" KESTREL_EXIT_AFTER_MS=150000 "$HOST" "$1.kestrel.json"
  # WebKitGTK under xvfb takes ~30 s to show a first page in CI; quitting
  # must still beat the safety timer by a wide margin.
  [ $((SECONDS - t0)) -lt 120 ] || { echo "FAIL: app.quit() didn't end the host" >&2; exit 1; }
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
