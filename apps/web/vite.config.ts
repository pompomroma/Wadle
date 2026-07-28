import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const SERVER = process.env["WADLE_SERVER"] ?? "http://127.0.0.1:5174";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // The API and the live product previews both live on the server.
      "/api": { target: SERVER, changeOrigin: true },
      "/p": { target: SERVER, changeOrigin: true },
    },
  },
  build: { outDir: "dist", sourcemap: true },
});
