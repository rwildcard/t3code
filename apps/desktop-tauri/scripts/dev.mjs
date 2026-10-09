// Runs `tauri dev` against the Vite server the dev-runner started. The
// dev-runner picks the web port per checkout, so devUrl cannot be static.
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

const devServerUrl = process.env.VITE_DEV_SERVER_URL?.trim();
if (!devServerUrl) {
  console.error(
    "[desktop-tauri] VITE_DEV_SERVER_URL is not set. Start through `vp run dev:desktop-tauri`.",
  );
  process.exit(1);
}

const require = NodeModule.createRequire(import.meta.url);
const cliPackageJson = require.resolve("@tauri-apps/cli/package.json");
const cliEntry = NodePath.join(NodePath.dirname(cliPackageJson), "tauri.js");

const child = NodeChildProcess.spawn(
  process.execPath,
  [cliEntry, "dev", "--config", JSON.stringify({ build: { devUrl: devServerUrl } })],
  { stdio: "inherit", cwd: NodePath.resolve(import.meta.dirname, "..") },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
