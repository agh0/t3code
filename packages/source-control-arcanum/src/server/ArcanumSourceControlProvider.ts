import * as Effect from "effect/Effect";
import { SourceControlProviderError } from "@t3tools/contracts";
import type { SourceControlApiDiscoverySpec } from "@t3tools/source-control-core/server/discovery";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";

import { definition } from "../shared/definition.ts";

import * as ArcanumApi from "./ArcanumApi.ts";

const unsupported = (operation: string) => (input: { readonly cwd: string }) =>
  Effect.fail(
    new SourceControlProviderError({
      provider: definition.kind,
      operation,
      cwd: input.cwd,
      detail: "This is not supported for Arcanum.",
    }),
  );

/** Unreachable in practice: no git remote is recognised as Arcanum's. */
export const make = Effect.succeed(
  SourceControlProvider.SourceControlProvider.of({
    kind: definition.kind,
    listChangeRequests: unsupported("listChangeRequests"),
    getChangeRequest: unsupported("getChangeRequest"),
    createChangeRequest: unsupported("createChangeRequest"),
    getRepositoryCloneUrls: unsupported("getRepositoryCloneUrls"),
    createRepository: unsupported("createRepository"),
    getDefaultBranch: unsupported("getDefaultBranch"),
    checkoutChangeRequest: unsupported("checkoutChangeRequest"),
  }),
);

export const makeDiscovery = Effect.gen(function* () {
  const api = yield* ArcanumApi.ArcanumApi;
  return {
    type: "api",
    kind: definition.kind,
    label: definition.label,
    installHint: ArcanumApi.ARC_INSTALL_HINT,
    probeAuth: api.probeAuth,
  } satisfies SourceControlApiDiscoverySpec;
});
