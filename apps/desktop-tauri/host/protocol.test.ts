import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { handleRequestLine } from "./protocol.ts";

class EchoFailure extends Schema.TaggedError<EchoFailure>()("EchoFailure", {
  reason: Schema.String,
}) {
  override get message(): string {
    return `echo failed: ${this.reason}`;
  }
}

const methods = {
  echo: (params: unknown) => Effect.succeed(params),
  fail: () => new EchoFailure({ reason: "nope" }),
  die: () => Effect.die(new Error("boom")),
};

describe("host protocol", () => {
  it.effect("ignores a line that is not JSON or carries no id", () =>
    Effect.gen(function* () {
      assert.isNull(yield* handleRequestLine(methods, "not json"));
      assert.isNull(yield* handleRequestLine(methods, '{"method":"echo"}'));
    }),
  );

  it.effect("answers a malformed request that has an id", () =>
    Effect.gen(function* () {
      const reply = yield* handleRequestLine(methods, '{"id":7,"params":1}');
      assert.deepEqual(reply, {
        id: 7,
        ok: false,
        error: { message: "Malformed request.", tag: "HostProtocolError" },
      });
    }),
  );

  it.effect("rejects an unknown method, including inherited object keys", () =>
    Effect.gen(function* () {
      const reply = yield* handleRequestLine(methods, '{"id":"a","method":"toString"}');
      assert.deepEqual(reply, {
        id: "a",
        ok: false,
        error: { message: "Unknown method: toString", tag: "HostUnknownMethodError" },
      });
    }),
  );

  it.effect("returns the handler's value", () =>
    Effect.gen(function* () {
      const reply = yield* handleRequestLine(
        methods,
        '{"id":1,"method":"echo","params":{"alias":"devbox"}}',
      );
      assert.deepEqual(reply, { id: 1, ok: true, value: { alias: "devbox" } });
    }),
  );

  it.effect("maps a tagged failure and a defect to error payloads", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* handleRequestLine(methods, '{"id":2,"method":"fail"}'), {
        id: 2,
        ok: false,
        error: { message: "echo failed: nope", tag: "EchoFailure" },
      });
      assert.deepEqual(yield* handleRequestLine(methods, '{"id":3,"method":"die"}'), {
        id: 3,
        ok: false,
        error: { message: "boom" },
      });
    }),
  );
});
