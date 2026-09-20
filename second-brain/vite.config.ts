import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Centralni Second Brain GUI (AI OS). Servira se na 4900 u dev-u; manifest se
// čita iz public/ (symlink na router-api/system_routing_manifest.json).
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 4900,
    strictPort: true,
    // /api ide na mali Node backend (server.mjs) koji čita atome sa diska.
    proxy: { "/api": "http://127.0.0.1:4901" },
  },
  preview: { host: "127.0.0.1", port: 4900, strictPort: true },
});
