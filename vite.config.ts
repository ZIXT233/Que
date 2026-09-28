import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import process from "node:process";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(() => ({
  plugins: [react()],
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
