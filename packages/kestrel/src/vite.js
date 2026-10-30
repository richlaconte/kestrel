// kestreljs/vite — Vite settings a Kestrel window needs, so app configs
// don't carry them. `kestrel dev` picks a free port and passes it in
// KESTREL_DEV_PORT.
//
//   import kestrel from "kestreljs/vite";
//   export default defineConfig({ plugins: [react(), kestrel()] });
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
  };
}
