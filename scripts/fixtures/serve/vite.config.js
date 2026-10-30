import { defineConfig } from "vite";
import kestrel from "kestreljs/vite";

// A Vite middleware API, the kind a real app uses for mocks: the dev proxy
// must forward its method, headers and body (#8).
const echoApi = {
  name: "echo-api",
  configureServer(server) {
    server.middlewares.use("/api/echo", (req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("X-Echo", "1");
        res.end(JSON.stringify({ method: req.method, type: req.headers["content-type"], body }));
      });
    });
  },
};

export default defineConfig({
  plugins: [echoApi, kestrel()],
  build: { target: "es2022" },
});
