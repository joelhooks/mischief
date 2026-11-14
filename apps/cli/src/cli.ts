#!/usr/bin/env node

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Approval } from "@mischief/capability";
import { FileInspector, ThinkTelemetry } from "@mischief/core";
import { Console, Effect, Layer } from "effect";
import * as Digest from "effect/crypto/Digest";

import { runCommand } from "./command.js";
import { localRunLayer } from "./run-layer.js";

const program = runCommand(process.argv.slice(2)).pipe(
  // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Oxlint mistakes this Effect handler for an async Promise callback.
  Effect.catchTag("FileStatsError", (error) =>
    Console.error(error.message).pipe(Effect.andThen(Effect.fail(error)))
  ),
  Effect.provide(
    Layer.mergeAll(
      Layer.provideMerge(FileInspector.layer, NodeServices.layer),
      localRunLayer.pipe(
        Layer.provide(Layer.merge(NodeServices.layer, Digest.layerWebCrypto))
      ),
      Approval.denyAll,
      ThinkTelemetry.unavailable
    )
  )
);

NodeRuntime.runMain(program);
