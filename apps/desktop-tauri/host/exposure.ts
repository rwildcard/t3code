// @effect-diagnostics nodeBuiltinImport:off - os.networkInterfaces() has no Effect service; the Electron shell wraps the same call.
import * as NodeOS from "node:os";

import { DesktopServerExposureModeSchema, type AdvertisedEndpoint } from "@t3tools/contracts";
import {
  isNetworkAccessUnavailable,
  resolveDesktopCoreAdvertisedEndpoints,
  resolveDesktopServerExposure,
} from "@t3tools/shared/desktopServerExposure";
import {
  disableTailscaleServe,
  readTailscaleStatus,
  resolveTailscaleAdvertisedEndpoints,
} from "@t3tools/tailscale";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as HttpClient from "effect/http/HttpClient";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

/**
 * Network exposure for the Tauri shell. Rust owns the settings and the
 * backend's bind host; these methods turn those settings into what the
 * Connections page shows (advertised endpoints, the LAN address) and run
 * the `tailscale` CLI, reusing the pure logic the Electron shell runs in
 * DesktopServerExposure.ts.
 */

const TAILSCALE_STATUS_CACHE_TTL = Duration.seconds(60);

/** What Rust knows: the persisted settings plus the backend port. */
const ExposureParams = Schema.Struct({
  mode: DesktopServerExposureModeSchema,
  port: Schema.Number,
  tailscaleServeEnabled: Schema.Boolean,
  tailscaleServePort: Schema.Number,
});

const DisableTailscaleServeParams = Schema.Struct({
  servePort: Schema.Number,
});

const decodeExposureParams = Schema.decodeUnknownEffect(ExposureParams);
const decodeDisableParams = Schema.decodeUnknownEffect(DisableTailscaleServeParams);

export interface ResolvedExposure {
  readonly endpointUrl: string | null;
  readonly advertisedHost: string | null;
  /** True when network access would reach nothing: no LAN or Tailscale address. */
  readonly unavailable: boolean;
}

const readNetworkInterfaces = Effect.sync(() => NodeOS.networkInterfaces());

const resolveExposure = Effect.fn("desktop-host.resolveServerExposure")(function* (
  params: unknown,
): Effect.fn.Return<ResolvedExposure, Schema.SchemaError> {
  const input = yield* decodeExposureParams(params);
  const networkInterfaces = yield* readNetworkInterfaces;
  const exposure = resolveDesktopServerExposure({
    mode: input.mode,
    port: input.port,
    networkInterfaces,
  });
  return {
    endpointUrl: exposure.endpointUrl,
    advertisedHost: exposure.advertisedHost,
    unavailable: isNetworkAccessUnavailable(exposure, networkInterfaces),
  };
});

export type ExposureMethodServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | HttpClient.HttpClient;

/** Typed here so tests see each method's failure; methods.ts widens them. */
export interface ExposureMethods {
  readonly resolveServerExposure: (
    params: unknown,
  ) => Effect.Effect<ResolvedExposure, Schema.SchemaError>;
  readonly resolveAdvertisedEndpoints: (
    params: unknown,
  ) => Effect.Effect<readonly AdvertisedEndpoint[], Schema.SchemaError, ExposureMethodServices>;
  readonly disableTailscaleServe: (
    params: unknown,
  ) => Effect.Effect<void, Schema.SchemaError, ChildProcessSpawner.ChildProcessSpawner>;
}

export const makeExposureMethods: Effect.Effect<ExposureMethods> = Effect.gen(function* () {
  // Cache the `tailscale status` spawn for the TTL. On macOS, the Mac App
  // Store Tailscale CLI lives inside Tailscale's sandbox container, so each
  // spawn re-triggers the "Other apps" TCC prompt. A missing CLI reads as
  // "no MagicDNS name" rather than an error.
  const cachedReadMagicDnsName = yield* Effect.cachedWithTTL(
    readTailscaleStatus.pipe(
      Effect.map((status) => status.magicDnsName),
      Effect.orElseSucceed(() => null),
    ),
    TAILSCALE_STATUS_CACHE_TTL,
  );

  const resolveAdvertisedEndpoints = Effect.fn("desktop-host.resolveAdvertisedEndpoints")(
    function* (
      params: unknown,
    ): Effect.fn.Return<readonly AdvertisedEndpoint[], Schema.SchemaError, ExposureMethodServices> {
      const input = yield* decodeExposureParams(params);
      const networkInterfaces = yield* readNetworkInterfaces;
      const exposure = resolveDesktopServerExposure({
        mode: input.mode,
        port: input.port,
        networkInterfaces,
      });
      const coreEndpoints = resolveDesktopCoreAdvertisedEndpoints({
        port: input.port,
        exposure,
      });
      // Don't spawn the Tailscale CLI when the user hasn't opted into any
      // network exposure (see the TCC note above).
      if (input.mode !== "network-accessible" && !input.tailscaleServeEnabled) {
        return coreEndpoints;
      }
      const tailscaleEndpoints = yield* resolveTailscaleAdvertisedEndpoints({
        port: input.port,
        serveEnabled: input.tailscaleServeEnabled,
        servePort: input.tailscaleServePort,
        networkInterfaces,
        readMagicDnsName: cachedReadMagicDnsName,
      });
      return [...coreEndpoints, ...tailscaleEndpoints];
    },
  );

  // The server turns Serve off on graceful shutdown, but on Windows the
  // shell ends the backend through a job object, so the shell asks for it
  // explicitly when Serve is disabled or moves to another port. Best
  // effort: without the CLI (or a mapping) there is nothing to undo.
  const disableServe = Effect.fn("desktop-host.disableTailscaleServe")(function* (
    params: unknown,
  ): Effect.fn.Return<void, Schema.SchemaError, ChildProcessSpawner.ChildProcessSpawner> {
    const input = yield* decodeDisableParams(params);
    yield* disableTailscaleServe({ servePort: input.servePort }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("tailscale serve off did not run", {
          servePort: input.servePort,
          error: error._tag,
        }),
      ),
    );
  });

  return {
    resolveServerExposure: resolveExposure,
    resolveAdvertisedEndpoints,
    disableTailscaleServe: disableServe,
  };
});
