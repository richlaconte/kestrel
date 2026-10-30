# Shared by the e2e-*.sh scripts: source it, don't run it.

# Remove a temp tree. WebView2's helper processes outlive the host by a
# moment and keep the webview data dir locked on Windows, so retry, then give
# up with a note: cleanup must never decide a test's result.
rm_tree() {
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    rm -rf "$1" 2>/dev/null && return 0
    sleep 1
  done
  echo "note: could not remove $1 (still locked)" >&2
}

# The executable `kestrel build` made for <appId>, run from the app dir:
# inside build/<Title>.app on macOS, build/<appId>/ elsewhere.
built_exe() {
  if [ "$(uname)" = Darwin ]; then
    echo "$PWD/$(ls -d build/*.app)/Contents/MacOS/$1"
  else
    echo "$PWD/build/$1/$1"
  fi
}
