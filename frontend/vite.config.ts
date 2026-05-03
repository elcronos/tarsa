import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../src/static",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api/events/stream": {
        target: "http://localhost:8100",
        changeOrigin: true,
        ws: false,
        configure: (proxy) => {
          proxy.on("proxyReq", (_proxyReq, _req, res) => {
            // Allow SSE to stream through without buffering
            res.setHeader("X-Accel-Buffering", "no");
          });
        },
      },
      "/api": {
        target: "http://localhost:8100",
        changeOrigin: true,
      },
    },
  },
});
