#!/bin/bash
# Kestrel macOS verification — written by Claude, run by double-click.
# Logs everything to macos-verify.log next to this script.
cd "$(dirname "$0")"
exec > >(tee macos-verify.log) 2>&1
set -x
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

echo "===== ENVIRONMENT ====="
sw_vers; uname -m
git --version || echo NO-GIT
cargo --version || echo NO-CARGO
node --version || echo NO-NODE
gh --version 2>/dev/null | head -1 || echo NO-GH

echo "===== GIT INIT + COMMIT ====="
if [ ! -d .git ]; then
  git init -b main
  git add .
  git -c user.name="Richard LaConte" -c user.email="richl.laconte@gmail.com" \
    commit -m "Kestrel: initial public spike — host, CLI, React template, RFC-0001

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012sGe9UaXjjm5XdVXVAVvfT" || echo COMMIT-FAILED
fi

echo "===== PUSH (private repo; flip public after naming) ====="
if gh auth status >/dev/null 2>&1; then
  gh repo create kestrel --private --source=. --push || git push -u origin main || echo PUSH-FAILED
else
  echo "NO-GH-AUTH: skipping push (run 'gh auth login' later)"
fi

echo "===== HOST BUILD — THE WKWEBVIEW MOMENT ====="
( cd host && cargo build --release ) || { echo HOST-BUILD-FAILED; exit 1; }
ls -la host/target/release/kestrel-host

echo "===== DEMO APP (a native window should appear for ~8s) ====="
node packages/kestrel/bin/kestrel.js create mac-demo --template=vanilla || true
( cd mac-demo && KESTREL_EXIT_AFTER_MS=8000 node ../packages/kestrel/bin/kestrel.js dev . )
if [ -f mac-demo/kestrel-data.json ]; then
  echo "IPC-VERIFIED-ON-MACOS: $(cat mac-demo/kestrel-data.json)"
else
  echo "IPC-FAILED: no kestrel-data.json"
fi
echo "===== DONE — full log in macos-verify.log ====="
