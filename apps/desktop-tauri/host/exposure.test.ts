import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import { makeExposureMethods } from "./exposure.ts";

const PORT = 3773;

// A machine without the tailscale CLI: every spawn fails, like ENOENT.
const layerNoTailscale = Layer.mergeAll(
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("unexpected Tailscale HTTPS probe")),
  ),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die(new Error("spawn tailscale.exe ENOENT"))),
  ),
);

const settings = (mode: "local-only" | "network-accessible", tailscaleServeEnabled = false) => ({
  mode,
  port: PORT,
  tailscaleServeEnabled,
  tailscaleServePort: 443,
});

describe("desktop host exposure methods", () => {
  it.effect("local-only advertises only the loopback endpoint and never spawns tailscale", () =>
    Effect.gen(function* () {
      const methods = yield* makeExposureMethods;
      const endpoints = yield* methods.resolveAdvertisedEndpoints(settings("local-only"));
      assert.deepEqual(
        endpoints.map((endpoint) => [endpoint.id, endpoint.httpBaseUrl]),
        [[`desktop-loopback:${PORT}`, `http://127.0.0.1:${PORT}/`]],
      );
      const state = yield* methods.resolveServerExposure(settings("local-only"));
      assert.deepEqual(state, { endpointUrl: null, advertisedHost: null, unavailable: false });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("unexpected Tailscale HTTPS probe")),
          ),
          Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() => Effect.die("unexpected tailscale spawn")),
          ),
        ),
      ),
    ),
  );

  it.effect("degrades to core endpoints when the tailscale CLI is missing", () =>
    Effect.gen(function* () {
      const methods = yield* makeExposureMethods;
      // Serve enabled forces the status read; with no CLI there is no
      // MagicDNS name and no error, just the loopback (and any LAN) entries.
      const endpoints = yield* methods.resolveAdvertisedEndpoints(
        settings("network-accessible", true),
      );
      assert.isAtLeast(endpoints.length, 1);
      assert.isTrue(endpoints.every((endpoint) => endpoint.provider.id === "desktop-core"));

      // Disabling Serve is best effort for the same reason.
      yield* methods.disableTailscaleServe({ servePort: 443 });
    }).pipe(Effect.provide(layerNoTailscale)),
  );

  it.effect("rejects malformed parameters from the shell", () =>
    Effect.gen(function* () {
      const methods = yield* makeExposureMethods;
      const exit = yield* Effect.exit(methods.resolveServerExposure({ mode: "lan" }));
      assert.isTrue(exit._tag === "Failure");
    }).pipe(Effect.provide(layerNoTailscale)),
  );
});
