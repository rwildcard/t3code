import { resolveSshTarget } from "@t3tools/ssh/command";
import { discoverSshHosts } from "@t3tools/ssh/config";
import type * as SshTunnel from "@t3tools/ssh/tunnel";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { makeExposureMethods } from "./exposure.ts";
import type { HostMethods } from "./protocol.ts";
import { makeSshMethods, type SshMethodServices, type SshMethodsOptions } from "./ssh.ts";

export type HostMethodServices = SshMethodServices;

const decodeAlias = Schema.decodeUnknownEffect(Schema.String);

/**
 * What the shell can ask for. Names and payloads match the DesktopBridge
 * methods in packages/contracts/src/ipc.ts (or, for the exposure methods,
 * the Rust commands that call them); the Electron shell runs the same
 * functions behind its IPC (apps/desktop/src/ssh, DesktopServerExposure.ts).
 */
export const makeMethods = (
  options: SshMethodsOptions,
): Effect.Effect<
  HostMethods<HostMethodServices>,
  never,
  SshTunnel.SshEnvironmentManager | SshMethodServices
> =>
  Effect.gen(function* () {
    const exposure = yield* makeExposureMethods;
    const ssh = yield* makeSshMethods(options);
    return {
      ping: () => Effect.succeed("pong"),
      discoverSshHosts: () => discoverSshHosts({}),
      // `ssh -G` evaluates the local config for the alias and exits; it never connects.
      resolveSshHost: (params) => decodeAlias(params).pipe(Effect.flatMap(resolveSshTarget)),
      ...ssh,
      ...exposure,
    };
  });
