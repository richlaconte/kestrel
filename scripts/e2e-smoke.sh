#!/usr/bin/env bash
# E2E smoke test: kestrel create → kestrel dev (headless) → assert the app's
# native functions actually round-tripped (they persist kestrel-data.json in
# the app's data dir, which KESTREL_DATA_DIR points at a temp dir here).
# Usage: e2e-smoke.sh [react|vanilla]   (run under xvfb-run in CI)
set -euo pipefail
. "$(dirname "$0")/e2e-lib.sh"

TEMPLATE="${1:-react}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Git Bash on Windows: npm and node want C:/… paths, not /c/….
if command -v cygpath >/dev/null 2>&1; then REPO_ROOT="$(cygpath -m "$REPO_ROOT")"; fi
KESTREL="node $REPO_ROOT/packages/kestrel/bin/kestrel.js"
WORK="$(mktemp -d)"
trap 'rc=$?; rm_tree "$WORK"; exit $rc' EXIT
DATA="$WORK/data"
KESTREL_DATA_DIR="$DATA"
command -v cygpath >/dev/null 2>&1 && KESTREL_DATA_DIR="$(cygpath -m "$DATA")"
export KESTREL_DATA_DIR

cd "$WORK"
echo "== create ($TEMPLATE) =="
$KESTREL create smoke-app --template="$TEMPLATE"
cd smoke-app

if [ "$TEMPLATE" = "react" ]; then
  echo "== npm install =="
  # Test the repo's CLI, not whatever kestreljs is on the registry (which may
  # lag behind or not exist yet for the version the template pins).
  npm pkg set "devDependencies.kestreljs=file:$REPO_ROOT/packages/kestrel"
  npm install --no-audit --no-fund --loglevel=error
fi

echo "== dev (headless, self-exiting) =="
$KESTREL dev . --exit-after=15000

echo "== assert IPC persistence =="
if [ ! -f "$DATA/kestrel-data.json" ]; then
  echo "FAIL: kestrel-data.json missing from the app data dir — native functions never ran" >&2
  exit 1
fi
test ! -e kestrel-data.json || { echo "FAIL: data file landed in the cwd" >&2; exit 1; }
grep -q '"visits": *1' "$DATA/kestrel-data.json"
echo "OK: $(cat "$DATA/kestrel-data.json")"

if [ "$TEMPLATE" = "react" ]; then
  echo "== assert typegen output =="
  test -f native-client.ts
  grep -q "Promise<string>" native-client.ts
  echo "OK: typed stubs present"
  # The app typechecks as shipped, kestreljs/native/host types included.
  node node_modules/typescript/bin/tsc --noEmit -p .
  echo "OK: template typechecks"
fi

# Both templates: the vanilla one builds from "frontend": ".", which holds
# build/ itself.
echo "== build =="
$KESTREL build . --dmg --deb --appimage # --dmg: macOS only; --deb, --appimage: Linux only
for f in icon.icns icon.ico 16x16.png 256x256.png 1024x1024.png; do
  test -s "build/icons/$f" || { echo "FAIL: build/icons/$f missing" >&2; exit 1; }
done
if [ "$(uname)" = Darwin ]; then
  # A real .app (#24): Info.plist, icon, manifest in Resources, signed.
  EXE="$(built_exe smoke-app)"
  APP="$(dirname "$(dirname "$(dirname "$EXE")")")"
  RES="$APP/Contents/Resources"
  plutil -lint "$APP/Contents/Info.plist" >/dev/null
  [ "$(plutil -extract CFBundleExecutable raw "$APP/Contents/Info.plist")" = smoke-app ]
  test -s "$RES/icon.icns"
  codesign --verify --strict "$APP"
  hdiutil verify build/*.dmg >/dev/null
  echo "OK: $(basename "$APP") is a signed .app"
else
  EXE="$(built_exe smoke-app)"
  RES="$(dirname "$EXE")"
fi
test -s "$RES/kestrel.json" && test -s "$RES/icon.png"
test ! -e "$RES/app/build" || { echo "FAIL: build/ was copied into the bundle" >&2; exit 1; }
echo "== run bundle from a foreign cwd =="
FOREIGN="$(mktemp -d)"
( cd "$FOREIGN" && KESTREL_EXIT_AFTER_MS=12000 "$EXE" )
# Same appId, same data dir: the bundle picks up dev's count.
grep -q '"visits": *2' "$DATA/kestrel-data.json" || { echo "FAIL: bundle IPC never ran" >&2; exit 1; }
test -z "$(ls -A "$FOREIGN")" || { echo "FAIL: bundle wrote into its cwd: $(ls -A "$FOREIGN")" >&2; exit 1; }
echo "OK: bundle ran from $FOREIGN, data stayed in the app data dir — $(cat "$DATA/kestrel-data.json")"
rm_tree "$FOREIGN"

visits() { node -p 'require(process.argv[1]).visits' "$DATA/kestrel-data.json"; }

# Linux (#26): the AppImage runs. With FUSE it mounts itself; without (some
# CI runners), it unpacks to a temp dir and runs from there.
if [ "$(uname)" = Linux ]; then
  echo "== run the AppImage =="
  IMG="$(ls build/*.AppImage)"
  test -x "$IMG"
  before=$(visits)
  if [ -e /dev/fuse ] && command -v fusermount3 >/dev/null; then MODE=mounted; else MODE=extracted; export APPIMAGE_EXTRACT_AND_RUN=1; fi
  ( cd / && KESTREL_EXIT_AFTER_MS=12000 "$WORK/smoke-app/$IMG" )
  unset APPIMAGE_EXTRACT_AND_RUN
  [ "$(visits)" -eq $((before + 1)) ] || { echo "FAIL: the AppImage's IPC never ran" >&2; exit 1; }
  echo "OK: $(basename "$IMG") runs ($MODE)"
fi

# Linux (#26): the .deb installs, runs from /usr/bin and uninstalls. Needs
# dpkg and password-less sudo, as on CI runners.
if [ "$(uname)" = Linux ] && command -v dpkg >/dev/null && sudo -n true 2>/dev/null; then
  echo "== install the .deb =="
  DEB="$(ls build/*.deb)"
  dpkg-deb --info "$DEB" | grep -q 'Package: smoke-app'
  sudo dpkg -i "$DEB"
  trap 'rc=$?; sudo dpkg -r smoke-app >/dev/null 2>&1 || true; rm_tree "$WORK"; exit $rc' EXIT
  test -x /opt/smoke-app/smoke-app
  grep -q '^Exec=/usr/bin/smoke-app$' /usr/share/applications/smoke-app.desktop
  test -s /usr/share/icons/hicolor/256x256/apps/smoke-app.png
  before=$(visits)
  ( cd / && KESTREL_EXIT_AFTER_MS=12000 smoke-app )
  [ "$(visits)" -eq $((before + 1)) ] || { echo "FAIL: the installed app's IPC never ran" >&2; exit 1; }
  sudo dpkg -r smoke-app
  test ! -e /opt/smoke-app || { echo "FAIL: dpkg -r left /opt/smoke-app" >&2; exit 1; }
  echo "OK: $(basename "$DEB") installs, runs from /usr/bin and uninstalls"
fi
