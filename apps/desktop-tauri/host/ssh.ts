import {
  bootstrapRemoteBearerSession,
  fetchRemoteSessionState,
  issueRemoteWebSocketTicket,
  RemoteEnvironmentAuthUndeclaredStatusError,
  type RemoteEnvironmentAuthError,
} from "@t3tools/client-runtime/authorization";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import {
  DesktopSshBearerBootstrapInputSchema,
  DesktopSshBearerRequestInputSchema,
  DesktopSshEnvironmentEnsureInputSchema,
  DesktopSshEnvironmentTargetSchema,
  DesktopSshHttpBaseUrlInputSchema,
  DesktopSshPasswordPromptCancelledType,
  DesktopSshPasswordPromptResolutionInputSchema,
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
  EnvironmentOperationForbiddenError,
  EnvironmentRequestInvalidError,
  EnvironmentScopeRequiredError,
  type DesktopSshPasswordPromptRequest,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as SshAuth from "@t3tools/ssh/auth";
import { SshHttpBridgeError } from "@t3tools/ssh/errors";
import * as SshTunnel from "@t3tools/ssh/tunnel";
import type * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as HttpClient from "effect/http/HttpClient";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as SshPrompts from "./sshPrompts.ts";

/**
 * The SSH connection methods: the Electron shell's DesktopSshEnvironment.ts
 * and ipc/methods/sshEnvironment.ts, minus the IPC. SshEnvironmentManager
 * (packages/ssh) owns the `ssh` tunnel processes for the helper's lifetime;
 * they end with the helper, which on Windows sits in the app's job object.
 * The remote API methods proxy the page's calls to the loopback tunnel, as
 * in Electron, so the page never fetches the tunnel origin itself.
 */

export type SshMethodServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | NetService.NetService
  | Path.Path;

type SshRequestOperation =
  | "fetch-environment-descriptor"
  | "bootstrap-bearer-session"
  | "fetch-session-state"
  | "issue-websocket-ticket";

type SshRequestCause = RemoteEnvironmentAuthError | SshHttpBridgeError;

const isEnvironmentAuthInvalidError = Schema.is(EnvironmentAuthInvalidError);
const isEnvironmentInternalError = Schema.is(EnvironmentInternalError);
const isEnvironmentOperationForbiddenError = Schema.is(EnvironmentOperationForbiddenError);
const isEnvironmentRequestInvalidError = Schema.is(EnvironmentRequestInvalidError);
const isEnvironmentScopeRequiredError = Schema.is(EnvironmentScopeRequiredError);

function readSshHttpStatus(cause: SshRequestCause): number | null {
  if (
    cause instanceof RemoteEnvironmentAuthUndeclaredStatusError ||
    cause instanceof SshHttpBridgeError
  ) {
    return cause.status ?? null;
  }
  if (isEnvironmentRequestInvalidError(cause)) return 400;
  if (isEnvironmentAuthInvalidError(cause)) return 401;
  if (isEnvironmentScopeRequiredError(cause)) return 403;
  if (isEnvironmentOperationForbiddenError(cause)) return 403;
  if (isEnvironmentInternalError(cause)) return 500;
  return null;
}

/** Same shape and message as the Electron shell's error, which the web app matches on. */
export class DesktopSshEnvironmentRequestError extends Data.TaggedError(
  "DesktopSshEnvironmentRequestError",
)<{
  readonly operation: SshRequestOperation;
  readonly cause: SshRequestCause;
  readonly sshHttpStatus: number | null;
}> {
  override get message() {
    const prefix = this.sshHttpStatus === null ? "" : `[ssh_http:${this.sshHttpStatus}] `;
    return `${prefix}SSH remote API request failed during ${this.operation}.`;
  }
}

const withLoopbackSshApi =
  <A, R>(
    operation: SshRequestOperation,
    use: (httpBaseUrl: string) => Effect.Effect<A, RemoteEnvironmentAuthError, R>,
  ) =>
  (httpBaseUrl: string): Effect.Effect<A, DesktopSshEnvironmentRequestError, R> =>
    SshTunnel.resolveLoopbackSshHttpBaseUrl(httpBaseUrl).pipe(
      Effect.flatMap(use),
      Effect.mapError(
        (cause) =>
          new DesktopSshEnvironmentRequestError({
            operation,
            cause,
            sshHttpStatus: readSshHttpStatus(cause),
          }),
      ),
    );

const decodeEnsureInput = Schema.decodeUnknownEffect(DesktopSshEnvironmentEnsureInputSchema);
const decodeTarget = Schema.decodeUnknownEffect(DesktopSshEnvironmentTargetSchema);
const decodeHttpBaseUrlInput = Schema.decodeUnknownEffect(DesktopSshHttpBaseUrlInputSchema);
const decodeBearerBootstrapInput = Schema.decodeUnknownEffect(DesktopSshBearerBootstrapInputSchema);
const decodeBearerRequestInput = Schema.decodeUnknownEffect(DesktopSshBearerRequestInputSchema);
const decodePromptResolution = Schema.decodeUnknownEffect(
  DesktopSshPasswordPromptResolutionInputSchema,
);

export interface SshMethodsOptions {
  readonly emitPasswordPrompt: (request: DesktopSshPasswordPromptRequest) => void;
  readonly promptTimeoutMs?: number;
}

export const makeSshMethods = Effect.fn("desktop-host.makeSshMethods")(function* (
  options: SshMethodsOptions,
) {
  const manager = yield* SshTunnel.SshEnvironmentManager;
  const prompts = yield* SshPrompts.make(
    options.emitPasswordPrompt,
    options.promptTimeoutMs === undefined ? {} : { timeoutMs: options.promptTimeoutMs },
  );
  const passwordPrompt = SshAuth.SshPasswordPrompt.of({
    isAvailable: true,
    request: (request) =>
      prompts.request(request).pipe(Effect.mapError(SshPrompts.toSshPasswordPromptError)),
  });

  return {
    // A cancelled or expired prompt is a result, not a failure, as in the
    // Electron IPC handler; the bridge rethrows its message like the preload.
    ensureSshEnvironment: (params: unknown) =>
      decodeEnsureInput(params).pipe(
        Effect.flatMap(({ target, options: ensureOptions }) =>
          manager.ensureEnvironment(target, ensureOptions),
        ),
        Effect.provideService(SshAuth.SshPasswordPrompt, passwordPrompt),
        Effect.catchIf(SshPrompts.isSshPasswordPromptCancellation, (error) =>
          Effect.succeed({ type: DesktopSshPasswordPromptCancelledType, message: error.message }),
        ),
      ),
    disconnectSshEnvironment: (params: unknown) =>
      decodeTarget(params).pipe(
        Effect.flatMap((target) => manager.disconnectEnvironment(target)),
        Effect.provideService(SshAuth.SshPasswordPrompt, passwordPrompt),
      ),
    fetchSshEnvironmentDescriptor: (params: unknown) =>
      decodeHttpBaseUrlInput(params).pipe(
        Effect.flatMap(({ httpBaseUrl }) =>
          withLoopbackSshApi("fetch-environment-descriptor", (resolved) =>
            fetchRemoteEnvironmentDescriptor({ httpBaseUrl: resolved }),
          )(httpBaseUrl),
        ),
      ),
    bootstrapSshBearerSession: (params: unknown) =>
      decodeBearerBootstrapInput(params).pipe(
        Effect.flatMap(({ httpBaseUrl, credential }) =>
          withLoopbackSshApi("bootstrap-bearer-session", (resolved) =>
            bootstrapRemoteBearerSession({ httpBaseUrl: resolved, credential }),
          )(httpBaseUrl),
        ),
      ),
    fetchSshSessionState: (params: unknown) =>
      decodeBearerRequestInput(params).pipe(
        Effect.flatMap(({ httpBaseUrl, bearerToken }) =>
          withLoopbackSshApi("fetch-session-state", (resolved) =>
            fetchRemoteSessionState({ httpBaseUrl: resolved, bearerToken }),
          )(httpBaseUrl),
        ),
      ),
    issueSshWebSocketTicket: (params: unknown) =>
      decodeBearerRequestInput(params).pipe(
        Effect.flatMap(({ httpBaseUrl, bearerToken }) =>
          withLoopbackSshApi("issue-websocket-ticket", (resolved) =>
            issueRemoteWebSocketTicket({ httpBaseUrl: resolved, bearerToken }),
          )(httpBaseUrl),
        ),
      ),
    resolveSshPasswordPrompt: (params: unknown) =>
      decodePromptResolution(params).pipe(Effect.flatMap(prompts.resolve)),
    // Rust calls this when the page reloads: the dialog that could answer is gone.
    abandonSshPasswordPrompts: () => prompts.abandonAll,
  };
});
