import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    port: 5183,
    strictPort: true,
    // The page is served from the kestrel:// origin via the host's dev proxy;
    // point the HMR websocket straight at the dev server.
    hmr: { protocol: "ws", host: "localhost", port: 5183 },
  },
});
