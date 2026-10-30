// Native-module watch for `kestrel dev` (#21): rebuild native.ts and its
// stubs whenever one of the files that went into the bundle changes.
import fs from "node:fs";
import path from "node:path";
import { runTypegen, TypegenError } from "./typegen.js";

/** Where `dev` leaves the current native build error for the Vite overlay. */
export const errorFile = (dir) => path.join(dir, ".kestrel", "native-error.json");

/**
 * Watch the native module's inputs. Each change runs typegen again, then
 * calls `onBuild(result)` or `onError(message)`. Directories are watched
 * rather than files, so editors that save by replacing the file still
 * trigger, and the set follows imports as they're added or removed.
 * Returns a function that stops watching.
 */
export function watchNative(dir, manifest, initialInputs, { onBuild, onError, debounceMs = 80 }) {
  const entry = path.resolve(dir, manifest.native);
  let inputs = new Set([entry, ...initialInputs]);
  const watchers = new Map(); // dir -> FSWatcher
  let timer = null;
  let stopped = false;

  const sync = () => {
    const dirs = new Set([...inputs].map((f) => path.dirname(f)));
    for (const [d, w] of watchers)
      if (!dirs.has(d)) {
        w.close();
        watchers.delete(d);
      }
    for (const d of dirs) {
      if (watchers.has(d)) continue;
      try {
        const w = fs.watch(d, (_event, name) => {
          // Some platforms omit the name; rebuild to be safe.
          if (!name || inputs.has(path.join(d, name.toString()))) schedule();
        });
        w.on("error", () => {});
        watchers.set(d, w);
      } catch {} // a directory that vanished: the next build reports it
    }
  };

  const rebuild = () => {
    timer = null;
    if (stopped) return;
    try {
      const res = runTypegen(dir, manifest);
      inputs = new Set([entry, ...res.inputs]);
      sync();
      onBuild(res);
    } catch (e) {
      // Anything else (an esbuild crash, a file vanishing mid-read) is
      // reported too: it runs in a timer, where a throw would end `dev`.
      onError(e instanceof TypegenError ? e.message : `native rebuild failed: ${e.stack ?? e}`);
    }
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(rebuild, debounceMs);
  };

  sync();
  return () => {
    stopped = true;
    clearTimeout(timer);
    for (const w of watchers.values()) w.close();
  };
}
