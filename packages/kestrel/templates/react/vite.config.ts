import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import kestrel from "kestreljs/vite";

export default defineConfig({
  plugins: [react(), kestrel()],
});
