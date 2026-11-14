import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { NodeServices } from "@effect/platform-node";
import { Effect, flow, Layer, Schema } from "effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { tupled } from "effect/Function";
import { FetchHttpClient } from "effect/http";

import { ClientError } from "./client-error.js";
import { projectClient } from "./project.js";
import { executeRequest, ToolInput } from "./tool.js";

type ToolArgs = Parameters<ToolDefinition["execute"]>;

const toolEffect = Effect.fn("MischiefClient.pi")(
  function* toolEffect(cwd: string, raw: ToolArgs[1]) {
    const input = yield* Schema.decodeUnknownEffect(ToolInput)(raw).pipe(
      Effect.mapError(
        () =>
          new ClientError({
            kind: "input",
            operation: "mischief",
            reason:
              "Invalid mischief input. Choose a configured host and request.action submit, inspect, abort or reply with its capability fields; retry mischief.",
          })
      )
    );

    return yield* executeRequest(yield* projectClient(cwd, input.host), input);
  },
  Effect.provide(
    Layer.mergeAll(
      NodeServices.layer,
      FetchHttpClient.layer,
      SecureRandom.layerWebCrypto
    )
  )
);

type Output = Effect.Success<ReturnType<typeof toolEffect>>;

type Failure = Effect.Error<ReturnType<typeof toolEffect>>;

export default function mischiefExtension(pi: ExtensionAPI) {
  const parameters = Schema.toJsonSchemaDocument(ToolInput);

  pi.registerTool({
    description:
      "Submit, inspect, abort or reply to a durable Mischief plan on a named host from this project's .pi/mischief.json. Each response names the run and how to inspect it. Plans can mail only names the host grants this caller. Read docs/first-plan.md before submitting.",
    execute: flow(
      (
        ...[_id, raw, signal, _update, ctx]: ToolArgs
      ): Parameters<typeof Effect.runPromise<Output, Failure>> => [
        toolEffect(ctx.cwd, raw),
        { signal },
      ],
      tupled(Effect.runPromise<Output, Failure>)
    ),
    label: "Mischief",
    name: "mischief",
    parameters: { ...parameters.schema, $defs: parameters.definitions },
  });
}
