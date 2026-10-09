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
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

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

// The HTTP client probes the Tailscale HTTPS endpoint (see exposure.ts).
// Node's own fetch rather than NodeHttpClient.layerUndici, which pulls undici
// in as a second bundle chunk; the release ships the helper as one file.
const runtime = ManagedRuntime.make(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer));
const methods = await runtime.runPromise(makeMethods);

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
