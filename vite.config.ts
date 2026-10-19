import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import process from "node:process";
import { execSync } from "node:child_process";

const host = process.env.TAURI_DEV_HOST;
// The commit beside the version, as the Rust build does (src-tauri/build.rs).
const commit = process.env.QUE_COMMIT || (() => {
  try { return execSync("git rev-parse --short=7 HEAD", { encoding: "utf8" }).trim(); } catch { return "unknown"; }
})();

export default defineConfig(() => ({
  plugins: [react()],
  define: { __QUE_COMMIT__: JSON.stringify(commit) },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      "next/navigation": path.resolve(import.meta.dirname, "./src/shims/next-navigation.ts"),
      "next/link": path.resolve(import.meta.dirname, "./src/shims/next-link.tsx"),
    },
  },
  clearScreen: false,
  server: {
    port: 1435,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1436,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
