import { resolveSshTarget } from "@t3tools/ssh/command";
import { discoverSshHosts } from "@t3tools/ssh/config";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";

import type { HostMethods } from "./protocol.ts";

export type HostMethodServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path;

const decodeAlias = Schema.decodeUnknownEffect(Schema.String);

/**
 * What the shell can ask for. Names and payloads match the DesktopBridge
 * methods in packages/contracts/src/ipc.ts; the Electron shell runs the same
 * packages/ssh functions behind its IPC (apps/desktop/src/ssh).
 */
export const methods: HostMethods<HostMethodServices> = {
  ping: () => Effect.succeed("pong"),
  discoverSshHosts: () => discoverSshHosts({}),
  // `ssh -G` evaluates the local config for the alias and exits; it never connects.
  resolveSshHost: (params) => decodeAlias(params).pipe(Effect.flatMap(resolveSshTarget)),
};
