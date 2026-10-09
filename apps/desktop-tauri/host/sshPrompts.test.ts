import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { DesktopSshPasswordPromptRequest } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as SshPrompts from "./sshPrompts.ts";

const TIMEOUT_MS = 1_000;

const layer = Layer.mergeAll(NodeServices.layer, TestClock.layer());

const makePrompts = Effect.gen(function* () {
  const emitted: DesktopSshPasswordPromptRequest[] = [];
  const prompts = yield* SshPrompts.make((request) => emitted.push(request), {
    timeoutMs: TIMEOUT_MS,
  });
  return { prompts, emitted };
});

const request = (prompts: SshPrompts.SshPrompts) =>
  prompts
    .request({
      destination: "devbox",
      username: "julius",
      prompt: "Enter the SSH password.",
      attempt: 1,
    })
    .pipe(Effect.forkScoped);

describe("desktop host SSH password prompts", () => {
  it.effect("emits one event per request and resolves it by id", () =>
    Effect.gen(function* () {
      const { prompts, emitted } = yield* makePrompts;
      const fiber = yield* request(prompts);
      yield* Effect.yieldNow;

      assert.equal(emitted.length, 1);
      const sent = emitted[0]!;
      assert.equal(sent.destination, "devbox");
      assert.equal(sent.username, "julius");
      assert.equal(sent.prompt, "Enter the SSH password.");
      // The deadline shown in the dialog is the one the service enforces.
      assert.equal(Date.parse(sent.expiresAt), TIMEOUT_MS);

      yield* prompts.resolve({ requestId: sent.requestId, password: "secret" });
      assert.equal(yield* Fiber.join(fiber), "secret");

      // Answering again is a stale dialog, not a second password.
      const stale = yield* prompts
        .resolve({ requestId: sent.requestId, password: "again" })
        .pipe(Effect.flip);
      assert.instanceOf(stale, SshPrompts.SshPromptExpiredError);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("a null password cancels, which ensure reports as a cancellation", () =>
    Effect.gen(function* () {
      const { prompts, emitted } = yield* makePrompts;
      const fiber = yield* request(prompts);
      yield* Effect.yieldNow;

      yield* prompts.resolve({ requestId: emitted[0]!.requestId, password: null });
      const error = yield* Fiber.join(fiber).pipe(Effect.flip);
      assert.instanceOf(error, SshPrompts.SshPromptCancelledError);
      assert.equal(error.message, "SSH authentication cancelled for devbox.");
      assert.isTrue(
        SshPrompts.isSshPasswordPromptCancellation(SshPrompts.toSshPasswordPromptError(error)),
      );
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("times out an unanswered prompt", () =>
    Effect.gen(function* () {
      const { prompts, emitted } = yield* makePrompts;
      const fiber = yield* request(prompts);
      yield* Effect.yieldNow;

      yield* TestClock.adjust(Duration.millis(TIMEOUT_MS));
      const error = yield* Fiber.join(fiber).pipe(Effect.flip);
      assert.instanceOf(error, SshPrompts.SshPromptTimedOutError);
      assert.equal(error.message, "SSH authentication timed out for devbox.");

      const stale = yield* prompts
        .resolve({ requestId: emitted[0]!.requestId, password: "late" })
        .pipe(Effect.flip);
      assert.instanceOf(stale, SshPrompts.SshPromptExpiredError);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("abandoning fails every pending prompt at once", () =>
    Effect.gen(function* () {
      const { prompts, emitted } = yield* makePrompts;
      const first = yield* request(prompts);
      const second = yield* request(prompts);
      yield* Effect.yieldNow;
      assert.equal(emitted.length, 2);

      yield* prompts.abandonAll;
      for (const fiber of [first, second]) {
        const error = yield* Fiber.join(fiber).pipe(Effect.flip);
        assert.instanceOf(error, SshPrompts.SshPromptAbandonedError);
      }
      assert.isTrue(
        SshPrompts.isSshPasswordPromptCancellation(
          SshPrompts.toSshPasswordPromptError(
            new SshPrompts.SshPromptAbandonedError({ requestId: "x", destination: "devbox" }),
          ),
        ),
      );
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("rejects a blank request id", () =>
    Effect.gen(function* () {
      const { prompts } = yield* makePrompts;
      const error = yield* prompts.resolve({ requestId: "  ", password: "x" }).pipe(Effect.flip);
      assert.instanceOf(error, SshPrompts.SshPromptInvalidRequestIdError);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});
