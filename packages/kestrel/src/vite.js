// kestreljs/vite — Vite settings a Kestrel window needs, so app configs
// don't carry them. `kestrel dev` picks a free port and passes it in
// KESTREL_DEV_PORT.
//
//   import kestrel from "kestreljs/vite";
//   export default defineConfig({ plugins: [react(), kestrel()] });
import fs from "node:fs";
import path from "node:path";

export default function kestrel() {
  return {
    name: "kestrel",
    config() {
      const port = Number(process.env.KESTREL_DEV_PORT) || 5183;
      return {
        // The host serves the built app from the kestrel:// origin root.
        base: "/",
        server: {
          port,
          strictPort: true,
          // The page is served from kestrel:// through the host's dev
          // proxy, so the HMR websocket must target the dev server directly.
          hmr: { protocol: "ws", host: "localhost", port },
        },
      };
    },
    // `kestrel dev` rebuilds native.ts on save and leaves a failed build's
    // message in .kestrel/native-error.json (see src/watch.js). Show it in
    // Vite's error overlay; reload once it's fixed to clear the overlay.
    configureServer(server) {
      const file = path.join(server.config.root, ".kestrel", "native-error.json");
      let showing = false;
      const show = () => {
        let message;
        try {
          message = JSON.parse(fs.readFileSync(file, "utf8")).message;
        } catch {
          return; // mid-write or gone; the next event settles it
        }
        showing = true;
        server.ws.send({
          type: "error",
          err: { message, stack: "", plugin: "kestrel", id: "native module" },
        });
      };
      server.watcher.add(file);
      server.watcher.on("add", (f) => path.resolve(f) === file && show());
      server.watcher.on("change", (f) => path.resolve(f) === file && show());
      server.watcher.on("unlink", (f) => {
        if (path.resolve(f) !== file || !showing) return;
        showing = false;
        server.ws.send({ type: "full-reload" });
      });
      // A window that connects while the build is broken sees it too.
      server.ws.on("connection", () => fs.existsSync(file) && show());
    },
  };
}
