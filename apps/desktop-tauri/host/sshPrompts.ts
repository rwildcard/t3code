import type { DesktopSshPasswordPromptRequest } from "@t3tools/contracts";
import type { SshPasswordRequest } from "@t3tools/ssh/auth";
import { SshPasswordPromptError } from "@t3tools/ssh/errors";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * In-app SSH password prompts for the Tauri shell. The Electron shell keeps
 * these in its main process (DesktopSshPasswordPrompts.ts) next to the
 * BrowserWindow; here the helper only owns the pending map and pushes one
 * `sshPasswordPrompt` event per request, which Rust forwards to the page
 * (and brings the window forward). The page answers through the
 * `resolveSshPasswordPrompt` method, keyed by request id.
 */

/** Matches DEFAULT_SSH_PASSWORD_PROMPT_TIMEOUT_MS in the Electron shell. */
const DEFAULT_PROMPT_TIMEOUT_MS = 3 * 60 * 1000;

export class SshPromptTimedOutError extends Schema.TaggedError<SshPromptTimedOutError>()(
  "SshPromptTimedOutError",
  { requestId: Schema.String, destination: Schema.String },
) {
  override get message(): string {
    return `SSH authentication timed out for ${this.destination}.`;
  }
}

export class SshPromptCancelledError extends Schema.TaggedError<SshPromptCancelledError>()(
  "SshPromptCancelledError",
  { requestId: Schema.String, destination: Schema.String },
) {
  override get message(): string {
    return `SSH authentication cancelled for ${this.destination}.`;
  }
}

/** The page that showed the prompt went away (reload or window close). */
export class SshPromptAbandonedError extends Schema.TaggedError<SshPromptAbandonedError>()(
  "SshPromptAbandonedError",
  { requestId: Schema.String, destination: Schema.String },
) {
  override get message(): string {
    return "SSH authentication was cancelled because the app window closed.";
  }
}

export class SshPromptRequestIdGenerationError extends Schema.TaggedError<SshPromptRequestIdGenerationError>()(
  "SshPromptRequestIdGenerationError",
  { destination: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return "Secure randomness is unavailable.";
  }
}

export class SshPromptInvalidRequestIdError extends Schema.TaggedError<SshPromptInvalidRequestIdError>()(
  "SshPromptInvalidRequestIdError",
  { requestId: Schema.String },
) {
  override get message(): string {
    return "Invalid SSH password prompt id.";
  }
}

export class SshPromptExpiredError extends Schema.TaggedError<SshPromptExpiredError>()(
  "SshPromptExpiredError",
  { requestId: Schema.String },
) {
  override get message(): string {
    return "SSH password prompt expired. Try connecting again.";
  }
}

export type SshPromptRequestError =
  | SshPromptTimedOutError
  | SshPromptCancelledError
  | SshPromptAbandonedError
  | SshPromptRequestIdGenerationError;

export type SshPromptResolveError = SshPromptInvalidRequestIdError | SshPromptExpiredError;

/**
 * The outcomes the Electron shell reports as "cancelled" rather than failed:
 * its IPC handler turns them into a `ssh-password-prompt-cancelled` result
 * and the preload rethrows the message.
 */
const SshPromptCancellation = Schema.Union([
  SshPromptTimedOutError,
  SshPromptCancelledError,
  SshPromptAbandonedError,
]);
const isSshPromptCancellation = Schema.is(SshPromptCancellation);

export function isSshPasswordPromptCancellation(error: unknown): error is SshPasswordPromptError {
  return error instanceof SshPasswordPromptError && isSshPromptCancellation(error.cause);
}

export function toSshPasswordPromptError(cause: SshPromptRequestError): SshPasswordPromptError {
  return new SshPasswordPromptError({ message: cause.message, cause });
}

export interface SshPrompts {
  readonly request: (request: SshPasswordRequest) => Effect.Effect<string, SshPromptRequestError>;
  readonly resolve: (input: {
    readonly requestId: string;
    readonly password: string | null;
  }) => Effect.Effect<void, SshPromptResolveError>;
  /** Fails every pending prompt; the page that could answer them is gone. */
  readonly abandonAll: Effect.Effect<void>;
}

export interface SshPromptsOptions {
  readonly timeoutMs?: number;
}

interface Pending {
  readonly destination: string;
  readonly deferred: Deferred.Deferred<string, SshPromptRequestError>;
}

export const make = Effect.fn("desktop-host.sshPrompts.make")(function* (
  emit: (request: DesktopSshPasswordPromptRequest) => void,
  options: SshPromptsOptions = {},
): Effect.fn.Return<SshPrompts, never, Crypto.Crypto> {
  const crypto = yield* Crypto.Crypto;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
  const pending = new Map<string, Pending>();

  const takePending = (requestId: string) =>
    Effect.sync(() => {
      const entry = pending.get(requestId);
      pending.delete(requestId);
      return Option.fromNullishOr(entry);
    });

  const request: SshPrompts["request"] = Effect.fn("desktop-host.sshPrompts.request")(
    function* (input) {
      const requestId = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(
          (cause) =>
            new SshPromptRequestIdGenerationError({ destination: input.destination, cause }),
        ),
      );
      const now = yield* DateTime.now;
      const deferred = yield* Deferred.make<string, SshPromptRequestError>();
      pending.set(requestId, { destination: input.destination, deferred });
      emit({
        requestId,
        destination: input.destination,
        username: input.username,
        prompt: input.prompt,
        expiresAt: DateTime.formatIso(DateTime.add(now, { milliseconds: timeoutMs })),
      });
      return yield* Deferred.await(deferred).pipe(
        Effect.timeoutOption(Duration.millis(timeoutMs)),
        Effect.flatMap(
          Option.match({
            onNone: () => new SshPromptTimedOutError({ requestId, destination: input.destination }),
            onSome: Effect.succeed,
          }),
        ),
        Effect.ensuring(takePending(requestId)),
      );
    },
  );

  const resolve: SshPrompts["resolve"] = Effect.fn("desktop-host.sshPrompts.resolve")(
    function* (input) {
      const requestId = input.requestId.trim();
      if (requestId.length === 0) {
        return yield* new SshPromptInvalidRequestIdError({ requestId: input.requestId });
      }
      const entry = yield* takePending(requestId);
      if (Option.isNone(entry)) {
        return yield* new SshPromptExpiredError({ requestId });
      }
      yield* input.password === null
        ? Deferred.fail(
            entry.value.deferred,
            new SshPromptCancelledError({ requestId, destination: entry.value.destination }),
          )
        : Deferred.succeed(entry.value.deferred, input.password);
    },
  );

  const abandonAll = Effect.suspend(() => {
    const entries = [...pending.entries()];
    pending.clear();
    return Effect.forEach(
      entries,
      ([requestId, entry]) =>
        Deferred.fail(
          entry.deferred,
          new SshPromptAbandonedError({ requestId, destination: entry.destination }),
        ),
      { discard: true },
    );
  });

  return { request, resolve, abandonAll };
});
