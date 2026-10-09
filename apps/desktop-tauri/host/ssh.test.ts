import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { DesktopSshPasswordPromptRequest } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as SshAuth from "@t3tools/ssh/auth";
import { SshHttpBridgeError, SshLaunchError } from "@t3tools/ssh/errors";
import * as SshTunnel from "@t3tools/ssh/tunnel";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { DesktopSshEnvironmentRequestError, makeSshMethods } from "./ssh.ts";

const target = { alias: "devbox", hostname: "devbox.example.com", username: "t3", port: 2222 };

const bootstrap = {
  target,
  httpBaseUrl: "http://127.0.0.1:41773/",
  wsBaseUrl: "ws://127.0.0.1:41773/",
  pairingToken: null,
};

/** A manager that asks for a password on the first ensure and connects on the second. */
const layerPromptingManager = Layer.effect(
  SshTunnel.SshEnvironmentManager,
  Effect.sync(() => {
    let attempts = 0;
    return SshTunnel.SshEnvironmentManager.of({
      ensureEnvironment: () =>
        Effect.gen(function* () {
          attempts += 1;
          if (attempts > 1) return bootstrap;
          const prompt = yield* SshAuth.SshPasswordPrompt;
          const password = yield* prompt.request({
            destination: target.alias,
            username: target.username,
            prompt: "Enter the SSH password.",
            attempt: 1,
          });
          if (password !== "secret") {
            return yield* new SshLaunchError({ message: "Permission denied.", stdout: "" });
          }
          return bootstrap;
        }),
      disconnectEnvironment: () => Effect.void,
    });
  }),
);

function layerHttpClient(
  handler: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse>,
) {
  return Layer.succeed(HttpClient.HttpClient, HttpClient.make(handler));
}

const jsonResponse = (request: HttpClientRequest.HttpClientRequest, body: unknown) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

const layerBase = Layer.mergeAll(
  NodeServices.layer,
  NetService.layer,
  layerHttpClient(() => Effect.die("unexpected request")),
);

describe("desktop host SSH methods", () => {
  it.effect("routes the manager's password prompt through the event and the resolve method", () =>
    Effect.gen(function* () {
      const emitted: DesktopSshPasswordPromptRequest[] = [];
      const methods = yield* makeSshMethods({
        emitPasswordPrompt: (request) => emitted.push(request),
      });
      const ensure = yield* methods
        .ensureSshEnvironment({ target, options: { issuePairingToken: false } })
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      assert.equal(emitted.length, 1);

      yield* methods.resolveSshPasswordPrompt({
        requestId: emitted[0]!.requestId,
        password: "secret",
      });
      assert.deepEqual(yield* Fiber.join(ensure), bootstrap);
    }).pipe(Effect.provide(Layer.mergeAll(layerBase, layerPromptingManager)), Effect.scoped),
  );

  it.effect("a cancelled prompt is a result the bridge rethrows, as in Electron", () =>
    Effect.gen(function* () {
      const emitted: DesktopSshPasswordPromptRequest[] = [];
      const methods = yield* makeSshMethods({
        emitPasswordPrompt: (request) => emitted.push(request),
      });
      const ensure = yield* methods.ensureSshEnvironment({ target }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      yield* methods.resolveSshPasswordPrompt({
        requestId: emitted[0]!.requestId,
        password: null,
      });
      assert.deepEqual(yield* Fiber.join(ensure), {
        type: "ssh-password-prompt-cancelled",
        message: "SSH authentication cancelled for devbox.",
      });
    }).pipe(Effect.provide(Layer.mergeAll(layerBase, layerPromptingManager)), Effect.scoped),
  );

  it.effect("rejects a malformed target before touching the manager", () =>
    Effect.gen(function* () {
      const methods = yield* makeSshMethods({ emitPasswordPrompt: () => undefined });
      const error = yield* methods
        .ensureSshEnvironment({ target: { alias: "devbox" } })
        .pipe(Effect.flip);
      assert.equal(error._tag, "SchemaError");
    }).pipe(Effect.provide(Layer.mergeAll(layerBase, layerPromptingManager)), Effect.scoped),
  );

  it.effect("proxies remote API calls to the loopback tunnel only", () =>
    Effect.gen(function* () {
      const urls: string[] = [];
      const methods = yield* makeSshMethods({ emitPasswordPrompt: () => undefined });
      const descriptor = yield* methods
        .fetchSshEnvironmentDescriptor({ httpBaseUrl: "http://127.0.0.1:41773/" })
        .pipe(
          Effect.provide(
            layerHttpClient((request) =>
              Effect.sync(() => {
                urls.push(request.url);
                return jsonResponse(request, {
                  environmentId: "remote-env",
                  label: "Remote Devbox",
                  platform: { os: "linux", arch: "x64" },
                  serverVersion: "1.2.3",
                  capabilities: { repositoryIdentity: true },
                });
              }),
            ),
          ),
        );
      assert.equal(descriptor.environmentId, "remote-env");
      assert.deepEqual(urls, ["http://127.0.0.1:41773/.well-known/t3/environment"]);

      const rejected = yield* methods
        .fetchSshSessionState({ httpBaseUrl: "http://devbox.example.com/", bearerToken: "t" })
        .pipe(Effect.flip);
      assert.instanceOf(rejected, DesktopSshEnvironmentRequestError);
      assert.instanceOf(rejected.cause, SshHttpBridgeError);
      assert.equal(rejected.operation, "fetch-session-state");
    }).pipe(Effect.provide(Layer.mergeAll(layerBase, layerPromptingManager)), Effect.scoped),
  );
});
