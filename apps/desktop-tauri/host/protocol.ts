import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/**
 * The line protocol between the Rust shell (src-tauri/src/host.rs) and this
 * helper. One JSON document per line on stdio: the shell sends requests, the
 * helper answers each by id and may push events at any time. Logs go to
 * stderr; stdout carries nothing else.
 */

const RequestId = Schema.Union([Schema.Number, Schema.String]);

const Request = Schema.Struct({
  id: RequestId,
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown),
});

const RequestWithId = Schema.Struct({ id: RequestId });

export interface HostErrorPayload {
  readonly message: string;
  readonly tag?: string;
}

export type HostReply =
  | { readonly id: number | string; readonly ok: true; readonly value: unknown }
  | { readonly id: number | string; readonly ok: false; readonly error: HostErrorPayload };

export interface HostEvent {
  readonly event: string;
  readonly payload: unknown;
}

export type HostMethods<R> = Record<
  string,
  (params: unknown) => Effect.Effect<unknown, unknown, R>
>;

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeRequest = Schema.decodeUnknownEffect(Request);
const decodeRequestId = Schema.decodeUnknownEffect(RequestWithId);

function errorPayload(cause: Cause.Cause<unknown>): HostErrorPayload {
  const error = Cause.squash(cause);
  const message = error instanceof Error ? error.message : String(error);
  const tag =
    Predicate.hasProperty(error, "_tag") && typeof error._tag === "string" ? error._tag : undefined;
  return tag === undefined ? { message } : { message, tag };
}

/**
 * Runs one request line against the method table. Resolves to `null` for a
 * line that carries no usable id, which the caller logs; every other line gets
 * a reply so the shell never waits on a request it sent.
 */
export const handleRequestLine = <R>(
  methods: HostMethods<R>,
  line: string,
): Effect.Effect<HostReply | null, never, R> =>
  Effect.gen(function* () {
    const json = yield* decodeJson(line).pipe(Effect.result);
    if (Result.isFailure(json)) return null;

    const request = yield* decodeRequest(json.success).pipe(Effect.result);
    if (Result.isFailure(request)) {
      const withId = yield* decodeRequestId(json.success).pipe(Effect.result);
      if (Result.isFailure(withId)) return null;
      return {
        id: withId.success.id,
        ok: false,
        error: { message: "Malformed request.", tag: "HostProtocolError" },
      };
    }

    const { id, method, params } = request.success;
    const handler = Object.hasOwn(methods, method) ? methods[method] : undefined;
    if (handler === undefined) {
      return {
        id,
        ok: false,
        error: { message: `Unknown method: ${method}`, tag: "HostUnknownMethodError" },
      };
    }

    // @effect-diagnostics-next-line anyUnknownInErrorContext:off - The table is generic over every method's failure; the payload keeps whatever tag and message it carries.
    const exit = yield* Effect.exit(handler(params));
    return Exit.isSuccess(exit)
      ? { id, ok: true, value: exit.value }
      : { id, ok: false, error: errorPayload(exit.cause) };
  });
