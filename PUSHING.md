# Getting this repo onto GitHub (5 minutes)

From the unpacked `kestrel/` directory on your Mac:

```sh
git init
git add .
git commit -m "Kestrel: initial public spike — host, CLI, React template, RFC-0001"

# create the repo (pick the real name first if you've decided!)
gh repo create kestrel --public --source=. --push
#   …or create it in the GitHub UI and:
# git remote add origin git@github.com:<you>/kestrel.git
# git push -u origin main
```

## What happens on first push

- **`.github/workflows/host.yml`** builds the host on Linux, macOS, and Windows
  (fail-fast off) and uploads each binary as an artifact. This is the moment the
  macOS/WKWebView and Windows/WebView2 questions start getting real answers.
  Known risk, annotated in the workflow: QuickJS on MSVC — if the Windows leg
  fails there, the fallback (GNU toolchain) is described inline.
- **`.github/workflows/e2e.yml`** runs `scripts/e2e-smoke.sh` for both templates
  headless: create → dev → assert the native-function round-trip persisted data
  and typegen emitted typed stubs. Both pass on Linux today (verified before
  packaging).

## Local sanity check on the Mac (before or after pushing)

```sh
cd host && cargo build --release && cd ..    # needs Rust + Xcode CLT
npm install
node packages/kestrel/bin/kestrel.js create demo
cd demo && npm install && npm run dev        # a native window with React + HMR
```

If the window opens and the visit counter ticks, WKWebView + custom protocol +
IPC all work on macOS and the architecture is three-for-three… at which point
it's probably time to pick the real name.

## Housekeeping before the repo is truly public

- `LICENSE` already says MIT with your name; `PUSHING.md` (this file) can be deleted.
- Decide the name → rename the npm packages (`kestrel`, `kestrel-native`), the
  `kestrel://` scheme string in `host/src/main.rs`, and the CLI banner.
- `docs/` contains the spike evidence (FINDINGS, FRICTION, screenshots) — great
  launch-post material, keep it.
