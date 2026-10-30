#!/usr/bin/env bash
# E2E webview storage isolation (#16): two apps share one host binary and the
# kestrel://localhost origin, yet must not share localStorage. Runs app A, then
# B, then A again, and checks what each saw at startup.
# Usage: e2e-storage.sh   (run under xvfb-run in CI)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${KESTREL_HOST:-$REPO_ROOT/host/target/release/kestrel-host}"
[ -x "$HOST" ] || HOST="$HOST.exe"
WORK="$(mktemp -d)"
# macOS keeps per-app WKWebView stores under ~/Library/WebKit, outside the
# data dir: remove the ones this run creates.
STORES="$HOME/Library/WebKit/$(basename "$HOST")/WebsiteDataStore"
BEFORE="$(ls "$STORES" 2>/dev/null || true)"
cleanup() {
  rm -rf "$WORK"
  if [ "$(uname)" = Darwin ] && [ -d "$STORES" ]; then
    for s in $(ls "$STORES"); do
      grep -qx "$s" <<<"$BEFORE" || rm -rf "${STORES:?}/$s"
    done
  fi
}
trap cleanup EXIT
cp -R "$REPO_ROOT/scripts/fixtures/storage/." "$WORK"
cd "$WORK"
native_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi; }

# Fresh ids each run: macOS keeps per-id stores outside the data dir.
RUN_ID="$RANDOM$RANDOM"
run() { # run <a|b>
  local id="kestrel-storage-$1-$RUN_ID"
  mkdir -p "data-$1"
  printf '{"appId":"%s","title":"Storage %s","frontend":".","native":"native.js","permissions":["fs:app-data"]}\n' \
    "$id" "$1" > "$1.kestrel.json"
  rm -f "data-$1/storage-result.json"
  KESTREL_DATA_DIR="$(native_path "$WORK/data-$1")" KESTREL_EXIT_AFTER_MS=8000 "$HOST" "$1.kestrel.json"
  test -f "data-$1/storage-result.json" || { echo "FAIL: app $1 never reported" >&2; exit 1; }
  cat "data-$1/storage-result.json"
}
expect() { # expect <app> <seen-json>
  grep -q "\"seen\":$2" "data-$1/storage-result.json" ||
    { echo "FAIL: app $1 saw $(cat "data-$1/storage-result.json"), expected seen=$2" >&2; exit 1; }
}

run a; echo; expect a null
run b; echo; expect b null
run a; echo; expect a "\"kestrel-storage-a-$RUN_ID\""
echo "OK: localStorage persists per app and is not shared between apps"
