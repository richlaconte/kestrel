#!/usr/bin/env bash
# E2E webview storage isolation (#16): two apps share one host binary and the
# kestrel://localhost origin, yet must not share localStorage. Runs app A, then
# B, then A again, and checks what each saw at startup.
# Usage: e2e-storage.sh   (run under xvfb-run in CI)
set -euo pipefail
. "$(dirname "$0")/e2e-lib.sh"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${KESTREL_HOST:-$REPO_ROOT/host/target/release/kestrel-host}"
[ -x "$HOST" ] || HOST="$HOST.exe"
WORK="$(mktemp -d)"
cp -R "$REPO_ROOT/scripts/fixtures/storage/." "$WORK"
cd "$WORK"
native_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi; }

# On Windows/Linux the webview's storage lives in the (temp) data dir. macOS
# keeps WKWebView stores in ~/Library/WebKit/<exe>/WebsiteDataStore/<id>,
# where <id> is host/src/scope.rs webview_store_id(appId), and WebKit may
# write them after the host exits. So the app ids are fixed, and their stores
# are cleared both before (leftovers from a previous run) and after.
fnv() { local h=$1 s=$2 i c; for ((i = 0; i < ${#s}; i++)); do printf -v c '%d' "'${s:i:1}"; h=$(((h ^ c) * 0x100000001b3)); done; printf '%016x' "$h"; }
store_id() { local a b; a=$(fnv 0xcbf29ce484222325 "$1"); b=$(fnv 0x6c62272e07bb0142 "$1"); echo "${a:0:8}-${a:8:4}-${a:12:4}-${b:0:4}-${b:4:12}"; }
STORES="$HOME/Library/WebKit/$(basename "$HOST")/WebsiteDataStore"
clear_stores() {
  [ "$(uname)" = Darwin ] || return 0
  for app in a b; do rm -rf "$STORES/$(store_id "kestrel-storage-$app")"; done
}
cleanup() {
  local rc=$?
  cd /
  rm_tree "$WORK"
  clear_stores
  exit "$rc"
}
trap cleanup EXIT
clear_stores

run() { # run <a|b>
  local id="kestrel-storage-$1"
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
run a; echo; expect a '"kestrel-storage-a"'
echo "OK: localStorage persists per app and is not shared between apps"
