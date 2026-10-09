import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: [
    // The bridge is injected into the webview as an initialization script by the
    // Rust shell (include_str!), so it must be a single self-contained classic script.
    {
      entry: ["src/bridge.ts"],
      format: "iife",
      platform: "browser",
      outDir: "dist",
      dts: false,
      clean: true,
      sourcemap: false,
    },
    // The desktop host helper (host/main.ts) ships as one file beside the
    // server bundle and runs on the packaged Node, so everything but Node's
    // own modules is inlined. Nothing in it is native.
    {
      entry: ["host/main.ts"],
      format: "esm",
      platform: "node",
      outDir: "dist/host",
      outExtensions: () => ({ js: ".mjs" }),
      dts: false,
      clean: false,
      sourcemap: false,
      deps: {
        alwaysBundle: (id) => !id.startsWith("node:"),
        onlyBundle: false,
      },
    },
  ],
});
