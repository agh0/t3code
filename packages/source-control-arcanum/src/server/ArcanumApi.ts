/**
 * Requests go to Arcanum's REST API with the token `arc token show` prints, which works from any
 * directory, so a review can be read from any project.
 */
import * as NodeOS from "node:os";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { SourceControlProviderAuth } from "@t3tools/contracts";
import { providerAuth } from "@t3tools/source-control-core/server/discovery";
import { PullRequestProviderError } from "@t3tools/source-control-core/server/PullRequestProvider";
import { retryAtFromHeader } from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";

import { ARCANUM_HOST, definition } from "../shared/definition.ts";

const API_ORIGIN = `https://${ARCANUM_HOST}`;
const TIMEOUT_MS = 30_000;
const TOKEN_TTL_MS = 5 * 60_000;
const MISSING_TOKEN_TTL_MS = 10_000;

const ARC_COMMAND = "arc";
export const ARC_INSTALL_HINT =
  "Install the Arc CLI, make it available on this environment's PATH, and check that `arc token show` prints a token.";
const UNAUTHENTICATED_DETAIL =
  "Arc has no token for Arcanum. Check that `arc token show` prints one, then retry.";

const providerError = (
  operation: string,
  reason: PullRequestProviderError["reason"],
  detail: string,
  extra?: { readonly retryAt?: number | undefined; readonly cause?: unknown },
) =>
  new PullRequestProviderError({
    provider: definition.kind,
    operation,
    reason,
    detail,
    ...(extra?.retryAt === undefined ? {} : { retryAt: extra.retryAt }),
    ...(extra?.cause === undefined ? {} : { cause: extra.cause }),
  });

export class ArcanumApi extends Context.Service<
  ArcanumApi,
  {
    /** One GET of an `/api/v1/...` path, query included, decoded with `schema`. */
    readonly get: <S extends Schema.Codec<unknown, unknown, never, never>>(
      input: { readonly operation: string; readonly path: string },
      schema: S,
    ) => Effect.Effect<S["Type"], PullRequestProviderError>;
    /** The login the token belongs to. */
    readonly viewer: () => Effect.Effect<string, PullRequestProviderError>;
    readonly probeAuth: Effect.Effect<SourceControlProviderAuth>;
  }
>()("@t3tools/source-control-arcanum/server/ArcanumApi") {}

const make = Effect.gen(function* () {
  const { process } = yield* SourceControlHost.SourceControlHost;
  const httpClient = yield* HttpClient.HttpClient;

  const readToken = process
    .run({
      operation: "Arcanum.token",
      command: ARC_COMMAND,
      args: ["token", "show"],
      cwd: NodeOS.homedir(),
      allowNonZeroExit: true,
      timeoutMs: TIMEOUT_MS,
      maxOutputBytes: 64_000,
      outputMode: "error",
    })
    .pipe(
      Effect.mapError((cause) =>
        cause._tag === "VcsProcessSpawnError" &&
        cause.cause instanceof PlatformError.PlatformError &&
        cause.cause.reason._tag === "NotFound"
          ? providerError("token", "missing-tool", "Arc CLI (`arc`) is not available on PATH.")
          : providerError("token", "failed", "Arc CLI could not be run.", { cause }),
      ),
      Effect.flatMap((result) => {
        const token = result.stdout.trim();
        return result.exitCode === 0 && token.length > 0 && !/\s/u.test(token)
          ? Effect.succeed(Redacted.make(token))
          : Effect.fail(providerError("token", "unauthenticated", UNAUTHENTICATED_DETAIL));
      }),
    );

  // One read at a time, so a burst of requests on a cold server runs `arc` once. A failed read is
  // shared for a few seconds, so a burst while signed out does not queue one process per request.
  const tokenLock = yield* Semaphore.make(1);
  let token: Result.Result<Redacted.Redacted<string>, PullRequestProviderError> | null = null;
  let tokenExpiresAt = 0;
  let viewerLogin: string | null = null;
  let viewerExpiresAt = 0;

  const currentToken = tokenLock.withPermits(1)(
    Effect.gen(function* () {
      if (token !== null && tokenExpiresAt > (yield* Clock.currentTimeMillis))
        return yield* Effect.fromResult(token);
      token = yield* Effect.result(readToken);
      tokenExpiresAt =
        (yield* Clock.currentTimeMillis) +
        (Result.isSuccess(token) ? TOKEN_TTL_MS : MISSING_TOKEN_TTL_MS);
      return yield* Effect.fromResult(token);
    }),
  );
  const forgetToken = (refused: Redacted.Redacted<string>) =>
    tokenLock.withPermits(1)(
      Effect.sync(() => {
        // A late 401 from an old request must not discard another request's fresh token.
        if (token !== null && Result.isSuccess(token) && token.success === refused) {
          token = null;
          viewerLogin = null;
        }
      }),
    );

  const send = (operation: string, path: string, credential: Redacted.Redacted<string>) =>
    httpClient
      .execute(
        HttpClientRequest.get(`${API_ORIGIN}${path}`).pipe(
          HttpClientRequest.setHeader("Authorization", `OAuth ${Redacted.value(credential)}`),
          HttpClientRequest.acceptJson,
        ),
      )
      .pipe(
        Effect.flatMap((response) =>
          response.text.pipe(
            Effect.map((body) => ({ status: response.status, headers: response.headers, body })),
          ),
        ),
        Effect.timeout(TIMEOUT_MS),
        Effect.mapError((cause) =>
          providerError(operation, "failed", "Could not reach Arcanum.", { cause }),
        ),
      );

  const exchange = Effect.fn("ArcanumApi.exchange")(function* (operation: string, path: string) {
    const credential = yield* currentToken;
    let reply = yield* send(operation, path, credential);
    // `arc` may have been signed in again since the token was read; read it once more.
    if (reply.status === 401) {
      yield* forgetToken(credential);
      reply = yield* send(operation, path, yield* currentToken);
    }
    if (reply.status >= 200 && reply.status < 300) return reply;
    const reason: PullRequestProviderError["reason"] =
      reply.status === 401
        ? "unauthenticated"
        : reply.status === 403
          ? "forbidden"
          : reply.status === 404
            ? "not-found"
            : reply.status === 429
              ? "rate-limited"
              : "failed";
    return yield* providerError(
      operation,
      reason,
      reason === "unauthenticated"
        ? UNAUTHENTICATED_DETAIL
        : reason === "rate-limited"
          ? "Arcanum API rate limit exceeded."
          : `Arcanum request failed (HTTP ${reply.status}).`,
      {
        retryAt:
          reason === "rate-limited"
            ? retryAtFromHeader(reply.headers["retry-after"], yield* Clock.currentTimeMillis)
            : undefined,
      },
    );
  });

  const get: ArcanumApi["Service"]["get"] = Effect.fn("ArcanumApi.get")(function* (input, schema) {
    const reply = yield* exchange(input.operation, input.path);
    return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(reply.body).pipe(
      Effect.mapError((cause) =>
        providerError(
          input.operation,
          "failed",
          "Arcanum returned a response this version cannot read.",
          { cause },
        ),
      ),
    );
  });

  // Arcanum has no "who am I" route, but names the token's user on every response it answers.
  const viewer = Effect.fn("ArcanumApi.viewer")(function* () {
    if (viewerLogin !== null && viewerExpiresAt > (yield* Clock.currentTimeMillis))
      return viewerLogin;
    const reply = yield* exchange("viewer", "/api/v1/review-requests?limit=1&fields=id");
    const login = reply.headers["x-arcanum-user"]?.trim();
    if (!login)
      return yield* providerError("viewer", "failed", "Arcanum did not say who is signed in.");
    viewerLogin = login;
    viewerExpiresAt = (yield* Clock.currentTimeMillis) + TOKEN_TTL_MS;
    return login;
  });

  const probeAuth = currentToken.pipe(
    Effect.match({
      onSuccess: () => providerAuth({ status: "authenticated", host: ARCANUM_HOST }),
      onFailure: (error) =>
        providerAuth({
          status: "unauthenticated",
          detail: error.reason === "missing-tool" ? ARC_INSTALL_HINT : error.detail,
        }),
    }),
  );

  return ArcanumApi.of({ get, viewer, probeAuth });
});

export const layer = Layer.effect(ArcanumApi, make);
