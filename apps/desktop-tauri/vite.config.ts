import { defineConfig } from "vite-plus";

// The bridge is injected into the webview as an initialization script by the
// Rust shell (include_str!), so it must be a single self-contained classic script.
export default defineConfig({
  pack: {
    entry: ["src/bridge.ts"],
    format: "iife",
    platform: "browser",
    outDir: "dist",
    dts: false,
    clean: true,
    sourcemap: false,
  },
});
