#!/usr/bin/env bash
# E2E serving: the dev proxy (methods, headers, body) and the built app's
# static server (MIME types, SPA fallback), in the real host.
# Usage: e2e-serve.sh   (run under xvfb-run in CI)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if command -v cygpath >/dev/null 2>&1; then REPO_ROOT="$(cygpath -m "$REPO_ROOT")"; fi
KESTREL="node $REPO_ROOT/packages/kestrel/bin/kestrel.js"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cp -R "$REPO_ROOT/scripts/fixtures/serve/." "$WORK"
cd "$WORK"
rm -f assert.mjs

npm pkg set "devDependencies.kestreljs=file:$REPO_ROOT/packages/kestrel"
npm install --no-audit --no-fund --loglevel=error

echo "== dev =="
$KESTREL dev . --exit-after=15000
echo "== build =="
$KESTREL build .
KESTREL_EXIT_AFTER_MS=12000 "./build/kestrel-serve-fixture/kestrel-serve-fixture"

node "$REPO_ROOT/scripts/fixtures/serve/assert.mjs" .
