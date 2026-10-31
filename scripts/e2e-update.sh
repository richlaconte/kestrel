#!/usr/bin/env bash
# E2E auto-update (#28): build 1.0.0, build 2.0.0 signed as an update, serve
# the feed locally, "install" 1.0.0 (a .app copy on macOS, an AppImage on
# Linux, the real installer on Windows) and run it.
#   1. A feed whose signature doesn't match is refused: permission_denied,
#      and the installed copy is still 1.0.0.
#   2. The real feed: 1.0.0 checks, applies, quits, and 2.0.0 starts in its
#      place and records that it ran; the installed copy is now 2.0.0.
# Usage: e2e-update.sh   (run under xvfb-run in CI)
set -euo pipefail
. "$(dirname "$0")/e2e-lib.sh"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if command -v cygpath >/dev/null 2>&1; then REPO_ROOT="$(cygpath -m "$REPO_ROOT")"; fi
KESTREL="node $REPO_ROOT/packages/kestrel/bin/kestrel.js"
WORK="$(mktemp -d)"
OS="$(uname)"; case "$OS" in MINGW*|MSYS*) OS=Windows ;; esac
APP_ID=kestrel-e2e-update
SERVER_PID=
INST_WIN=
cleanup() {
  rc=$?
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  if [ -n "$INST_WIN" ]; then MSYS2_ARG_CONV_EXCL='*' timeout 300 "$(cygpath -u "$INST_WIN")/uninstall.exe" /S "_?=$INST_WIN" || true; fi
  cd /; rm_tree "$WORK"; exit $rc
}
trap cleanup EXIT
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi; }

cp -R "$REPO_ROOT/scripts/fixtures/update/." "$WORK/app"
cp "$REPO_ROOT/packages/kestrel-native/index.js" "$WORK/app/kestrel-native.js"
cd "$WORK/app"

echo "== keys and feed URL =="
$KESTREL updater keygen "$WORK/update.key" > "$WORK/keygen.txt"
PUBKEY="$(sed -n 's/.*"pubkey": "\(.*\)".*/\1/p' "$WORK/keygen.txt")"
PORT="$(node -e 'const s=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})')"
manifest() { # manifest <version>
  printf '{"appId":"%s","title":"Update Test","version":"%s","frontend":".","updater":{"endpoint":"http://127.0.0.1:%s/latest.json","pubkey":"%s"}}\n' \
    "$APP_ID" "$1" "$PORT" "$PUBKEY" > kestrel.json
}
FLAGS=; [ "$OS" = Linux ] && FLAGS=--appimage; [ "$OS" = Windows ] && FLAGS=--installer

echo "== build 1.0.0 =="
manifest 1.0.0
$KESTREL build . $FLAGS
mv build "$WORK/v1"

echo "== build 2.0.0, signed as an update =="
manifest 2.0.0
KESTREL_UPDATER_KEY="$(native "$WORK/update.key")" $KESTREL build . $FLAGS --notes="Second version"
mv build "$WORK/v2"
test -s "$WORK/v2/latest.json"
node -e 'const f=require(process.argv[1]); if (f.version!=="2.0.0"||f.notes!=="Second version"||Object.keys(f.platforms).length!==1) process.exit(1)' "$(native "$WORK/v2/latest.json")"

echo "== serve the feed =="
mkdir -p "$WORK/www"
node -e '
const http=require("http"),fs=require("fs"),path=require("path");
const [dir,port]=process.argv.slice(1);
http.createServer((q,r)=>{const f=path.join(dir,decodeURIComponent(new URL(q.url,"http://x").pathname));
  fs.readFile(f,(e,b)=>{if(e){r.writeHead(404);r.end();}else{r.writeHead(200);r.end(b);}});}).listen(+port,"127.0.0.1");
' "$(native "$WORK/www")" "$PORT" &
SERVER_PID=$!

DATA="$WORK/data"
store_log() { node -p 'JSON.stringify(require(process.argv[1]).log ?? [])' "$(native "$DATA/.kestrel/store.json")" 2>/dev/null || echo '[]'; }

install_v1() {
  rm_tree "$DATA"; mkdir -p "$DATA"
  case "$OS" in
    Darwin)
      rm_tree "$WORK/installed"; mkdir -p "$WORK/installed"
      cp -R "$WORK"/v1/*.app "$WORK/installed/"
      APP="$(ls -d "$WORK"/installed/*.app)"
      EXE="$APP/Contents/MacOS/$APP_ID" ;;
    Linux)
      rm_tree "$WORK/installed"; mkdir -p "$WORK/installed"
      cp "$WORK"/v1/*.AppImage "$WORK/installed/Update-Test.AppImage"
      EXE="$WORK/installed/Update-Test.AppImage" ;;
    Windows)
      MSYS2_ARG_CONV_EXCL='*' timeout 300 "$(ls "$WORK"/v1/*-setup.exe)" /S
      INST_WIN="$(MSYS2_ARG_CONV_EXCL='*' reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\$APP_ID" /v InstallLocation | tr -d '\r' | sed -n 's/.*REG_SZ *//p')"
      EXE="$(cygpath -u "$INST_WIN")/$APP_ID.exe" ;;
  esac
}

installed_version() {
  case "$OS" in
    Darwin) plutil -extract CFBundleShortVersionString raw "$APP/Contents/Info.plist" ;;
    Linux) if cmp -s "$EXE" "$WORK"/v2/*.AppImage; then echo 2.0.0; elif cmp -s "$EXE" "$WORK"/v1/*.AppImage; then echo 1.0.0; else echo unknown; fi ;;
    Windows) MSYS2_ARG_CONV_EXCL='*' reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\$APP_ID" /v DisplayVersion | tr -d '\r' | sed -n 's/.*REG_SZ *//p' ;;
  esac
}

run_v1() {
  # The safety timer and data dir carry over to the relaunched version.
  ( cd / && KESTREL_DATA_DIR="$(native "$DATA")" KESTREL_EXIT_AFTER_MS=90000 with_timeout 120 "$EXE" ) || true
}

echo "== 1. a signature that doesn't match is refused =="
cp "$WORK"/v2/* "$WORK/www/" 2>/dev/null || true
node -e '
const fs=require("fs"),f=JSON.parse(fs.readFileSync(process.argv[1]));
for (const a of Object.values(f.platforms)) a.signature=Buffer.alloc(64,7).toString("base64");
fs.writeFileSync(process.argv[1],JSON.stringify(f));' "$(native "$WORK/www/latest.json")"
install_v1
run_v1
LOG="$(store_log)"; echo "log: $LOG"
node -e '
const log=JSON.parse(process.argv[1]);
const ok=log[0]?.v==="1.0.0" && log[1]?.check?.version==="2.0.0" && log[1].check.canApply===true
  && log[2]?.error==="permission_denied" && log.length===3;
process.exit(ok?0:1)' "$LOG" || { echo "FAIL: a bad signature wasn't refused" >&2; exit 1; }
[ "$(installed_version)" = 1.0.0 ] || { echo "FAIL: the installed copy changed: $(installed_version)" >&2; exit 1; }
echo "OK: the tampered update was refused and 1.0.0 is untouched"

echo "== 2. the real update installs and relaunches =="
cp "$WORK/v2/latest.json" "$WORK/www/latest.json"
[ "$OS" = Windows ] || install_v1   # Windows: 1.0.0 is still installed
rm_tree "$DATA"; mkdir -p "$DATA"
run_v1
for _ in $(seq 1 90); do
  case "$(store_log)" in *'"2.0.0"'*'"v":"2.0.0"'*|*'{"v":"2.0.0"}'*) break ;; esac
  sleep 1
done
LOG="$(store_log)"; echo "log: $LOG"
node -e '
const log=JSON.parse(process.argv[1]);
const ok=log[0]?.v==="1.0.0" && log[1]?.check?.version==="2.0.0" && log[1].check.notes==="Second version"
  && log.at(-1)?.v==="2.0.0" && !log.some((e)=>e.error);
process.exit(ok?0:1)' "$LOG" || { echo "FAIL: 2.0.0 never ran after the update" >&2; exit 1; }
[ "$(installed_version)" = 2.0.0 ] || { echo "FAIL: the installed copy is $(installed_version), not 2.0.0" >&2; exit 1; }
if [ "$OS" = Darwin ]; then
  codesign --verify --strict "$APP"
  test -z "$(ls -A "$WORK/installed" | grep -v '\.app$')" || { echo "FAIL: the update left files beside the app: $(ls -A "$WORK/installed")" >&2; exit 1; }
fi
echo "OK: 1.0.0 updated itself to 2.0.0 on $OS and relaunched"
