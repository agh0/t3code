/**
 * The Arcanum driver: read-only pull requests through Arcanum's REST API, signed in with the
 * `arc` CLI's token.
 *
 * @module source-control-arcanum/server/driver
 */
import {
  defineSourceControlDriver,
  withOwnServices,
} from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";

import { definition } from "../shared/definition.ts";

import * as ArcanumApi from "./ArcanumApi.ts";
import * as ArcanumPullRequestProvider from "./ArcanumPullRequestProvider.ts";
import * as ArcanumSourceControlProvider from "./ArcanumSourceControlProvider.ts";

const makeInstance = Effect.all({
  sourceControl: ArcanumSourceControlProvider.make,
  discovery: ArcanumSourceControlProvider.makeDiscovery,
  pullRequests: ArcanumPullRequestProvider.make,
});

export const driver = defineSourceControlDriver({
  kind: definition.kind,
  definition,
  make: withOwnServices(makeInstance, ArcanumApi.layer),
});
