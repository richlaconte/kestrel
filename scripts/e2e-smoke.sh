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
WINDOWS=; case "$(uname)" in MINGW*|MSYS*) WINDOWS=1 ;; esac
if [ -n "$WINDOWS" ]; then
  # #25: sign with a throwaway self-signed certificate, so the build's
  # signing path runs for real (Windows won't trust it, which is fine here).
  PFX="$(cygpath -w "$WORK/e2e-sign.pfx")"
  powershell -NoProfile -Command "\$c = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=Kestrel e2e' -CertStoreLocation Cert:\CurrentUser\My; Export-PfxCertificate -Cert \$c -FilePath '$PFX' -Password (ConvertTo-SecureString -String 'e2e-pass' -Force -AsPlainText) | Out-Null; \$c | Remove-Item"
  export KESTREL_WIN_SIGN_PFX="$PFX" KESTREL_WIN_SIGN_PASSWORD=e2e-pass
fi
# --dmg: macOS only; --deb, --appimage: Linux only; --installer: Windows only
$KESTREL build . --dmg --deb --appimage --installer
unset KESTREL_WIN_SIGN_PFX KESTREL_WIN_SIGN_PASSWORD
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

visits() { node -p 'require(process.argv[1]).visits' "$KESTREL_DATA_DIR/kestrel-data.json"; }

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

# Windows (#25): the installer is signed, installs per user without a
# prompt (/S), runs, and uninstalls cleanly.
if [ -n "$WINDOWS" ]; then
  echo "== install with the setup.exe =="
  SETUP="$(ls build/*-setup.exe)"
  signer() { powershell -NoProfile -Command "(Get-AuthenticodeSignature '$(cygpath -w "$1")').SignerCertificate.Subject"; }
  for f in "$SETUP" "build/smoke-app/smoke-app.exe"; do
    [ "$(signer "$f" | tr -d '\r')" = "CN=Kestrel e2e" ] || { echo "FAIL: $f isn't signed" >&2; exit 1; }
  done
  KEY='HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\smoke-app'
  # Git Bash would turn a bare /S into the path S:/ and the installer would
  # wait on its GUI; the timeout catches any GUI that opens anyway.
  MSYS2_ARG_CONV_EXCL='*' timeout 300 "$SETUP" /S
  INST_WIN="$(MSYS2_ARG_CONV_EXCL='*' reg query "$KEY" /v InstallLocation | tr -d '\r' | sed -n 's/.*REG_SZ *//p')"
  INST="$(cygpath -u "$INST_WIN")"
  trap 'rc=$?; [ -x "$INST/uninstall.exe" ] && MSYS2_ARG_CONV_EXCL="*" timeout 300 "$INST/uninstall.exe" /S "_?=$INST_WIN"; rm_tree "$WORK"; exit $rc' EXIT
  case "$INST_WIN" in *\\AppData\\Local\\Programs\\smoke-app) ;; *) echo "FAIL: installed to $INST_WIN" >&2; exit 1 ;; esac
  test -f "$INST/smoke-app.exe" && test -f "$INST/kestrel.json" && test -f "$INST/icon.ico" && test -f "$INST/app/index.html"
  [ "$(signer "$INST/uninstall.exe" | tr -d '\r')" = "CN=Kestrel e2e" ] || { echo "FAIL: the uninstaller isn't signed" >&2; exit 1; }
  LNK="$APPDATA/Microsoft/Windows/Start Menu/Programs/smoke-app.lnk"
  test -f "$LNK" || { echo "FAIL: no Start-menu shortcut" >&2; exit 1; }
  before=$(visits)
  ( cd / && KESTREL_EXIT_AFTER_MS=12000 "$INST/smoke-app.exe" )
  [ "$(visits)" -eq $((before + 1)) ] || { echo "FAIL: the installed app's IPC never ran" >&2; exit 1; }
  # _?= runs the uninstaller in place and waits; it can't delete itself.
  MSYS2_ARG_CONV_EXCL='*' timeout 300 "$INST/uninstall.exe" /S "_?=$INST_WIN"
  ! MSYS2_ARG_CONV_EXCL='*' reg query "$KEY" >/dev/null 2>&1 || { echo "FAIL: the uninstall key is still there" >&2; exit 1; }
  test ! -e "$LNK" || { echo "FAIL: the shortcut is still there" >&2; exit 1; }
  test ! -e "$INST/smoke-app.exe" || { echo "FAIL: the app is still installed" >&2; exit 1; }
  rm_tree "$INST"
  echo "OK: $(basename "$SETUP") is signed, installs per user, runs and uninstalls"
fi
