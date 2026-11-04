import { runCapabilities } from "@mischief/core";
import { Effect, Schema } from "effect";

import type { MischiefClient } from "./client.js";

export const ToolInput = Schema.Struct({
  host: Schema.String,
  request: Schema.Union([
    Schema.Struct({
      action: Schema.Literal("submit"),
      ...runCapabilities[0].contract.input.fields,
    }),
    Schema.Struct({
      action: Schema.Literal("inspect"),
      ...runCapabilities[1].contract.input.fields,
    }),
    Schema.Struct({
      action: Schema.Literal("abort"),
      ...runCapabilities[5].contract.input.fields,
    }),
    Schema.Struct({
      action: Schema.Literal("reply"),
      ...runCapabilities[7].contract.input.fields,
    }),
  ]),
});

export const executeRequest = Effect.fn("MischiefClient.tool")(
  function* executeRequest(
    client: MischiefClient,
    { host, request }: typeof ToolInput.Type
  ) {
    const run = yield* (() => {
      if (request.action === "submit") {
        return client.submitPlan(request);
      }

      if (request.action === "inspect") {
        return client.inspectRun(request);
      }

      if (request.action === "abort") {
        return client.abortRun(request);
      }

      return client.deliverReply(request);
    })();

    return {
      content: [
        {
          text: `${run.runId} · ${run.status}\nInspect: mischief ${JSON.stringify({ host, request: { action: "inspect", runId: run.runId } })}`,
          type: "text" as const,
        },
      ],
      details: run,
    };
  }
);
