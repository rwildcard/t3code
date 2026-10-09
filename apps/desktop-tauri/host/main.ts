// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - This is the process entry: it owns stdio and the runtime, nothing above it provides them.
/**
 * The desktop host helper: a Node process the Tauri shell spawns on first use
 * to run the desktop-only TypeScript (packages/ssh and network exposure now; WSL
 * later) that the Electron main process used to run in-process. Rust keeps
 * settings and backend supervision; this process only answers requests.
 *
 * stdout is the reply channel (see protocol.ts), so everything that would
 * print goes to stderr, including `console.log` from any dependency.
 */
import * as NodeConsole from "node:console";
import * as NodeProcess from "node:process";
import * as NodeReadline from "node:readline";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import * as SshTunnel from "@t3tools/ssh/tunnel";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import serverPackageJson from "../../server/package.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };

import { makeMethods } from "./methods.ts";
import { handleRequestLine, type HostEvent, type HostReply } from "./protocol.ts";

globalThis.console = new NodeConsole.Console({
  stdout: NodeProcess.stderr,
  stderr: NodeProcess.stderr,
});

// The release build's self-containment probe loads the bundle this way.
if (NodeProcess.argv.includes("--version")) {
  NodeProcess.stdout.write(`${packageJson.version}\n`);
  NodeProcess.exit(0);
}

const encodeLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function writeMessage(message: HostReply | HostEvent): void {
  NodeProcess.stdout.write(`${encodeLine(message)}\n`);
}

function envNonEmpty(name: string): string | undefined {
  return NodeProcess.env[name]?.trim() || undefined;
}

// What the remote runs, decided as in the Electron shell (main.ts
// resolveDesktopSshCliRunner): the self-contained release archive of the
// app's own version, or in development a source checkout on the remote when
// T3CODE_DEV_REMOTE_T3_SERVER_ENTRY_PATH names one. Rust passes the version;
// dev mode is keyed off VITE_DEV_SERVER_URL like the rest of the shell.
function resolveCliRunner(): SshTunnel.RemoteT3RunnerOptions {
  const devRemoteEntryPath = envNonEmpty("T3CODE_DEV_REMOTE_T3_SERVER_ENTRY_PATH");
  if (envNonEmpty("VITE_DEV_SERVER_URL") !== undefined && devRemoteEntryPath !== undefined) {
    return { nodeScriptPath: devRemoteEntryPath, nodeEngineRange: serverPackageJson.engines.node };
  }
  return { archiveVersion: envNonEmpty("T3CODE_TAURI_APP_VERSION") ?? packageJson.version };
}

// The HTTP client probes the Tailscale HTTPS endpoint (see exposure.ts) and
// the SSH tunnels' loopback ends. Node's own fetch rather than
// NodeHttpClient.layerUndici, which pulls undici in as a second bundle chunk;
// the release ships the helper as one file.
//
// The SSH manager lives in the runtime's scope: when the shell closes stdin,
// `dispose` runs its finalizers, which end the tunnels and stop the managed
// remote servers, as the Electron shell's layer teardown does on quit.
const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    NodeServices.layer,
    FetchHttpClient.layer,
    NetService.layer,
    SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(resolveCliRunner()) }),
  ),
);
const methods = await runtime.runPromise(
  makeMethods({
    emitPasswordPrompt: (request) => writeMessage({ event: "sshPasswordPrompt", payload: request }),
  }),
);

const input = NodeReadline.createInterface({ input: NodeProcess.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (line.trim().length === 0) return;
  void runtime.runPromise(handleRequestLine(methods, line)).then((reply) => {
    if (reply === null) {
      console.error(`[desktop-host] ignoring a line that is not a request (${line.length} bytes)`);
      return;
    }
    writeMessage(reply);
  });
});
// The shell closing stdin is the shutdown signal (on Windows the job object
// also ends the process with the app).
input.on("close", () => {
  void runtime.dispose().finally(() => NodeProcess.exit(0));
});
