// @effect-diagnostics globalFetch:off -- the offline transport is a rejecting fetch, and an approved online plan uses the platform fetch.
import { NodeServices } from "@effect/platform-node";
import { AlchemyContextLive } from "alchemy/AlchemyContext";
import { provideFreshArtifactStore } from "alchemy/Artifacts";
import { layerNonInteractive } from "alchemy/Interaction";
import * as Plan from "alchemy/Plan";
import { evalStack } from "alchemy/Stack";
import { localState } from "alchemy/State/LocalState";
import { Cause, Effect, Layer, Option } from "effect";
import { FetchHttpClient } from "effect/http";

import { cloudflare } from "./alchemy.run.ts";

const refuse = (reason: string) => Effect.die(new Error(reason));

// oxlint-disable-next-line typescript/promise-function-async -- A rejecting transport never performs I/O.
const offlineFetch: typeof fetch = () =>
  Promise.reject(new Error("OFFLINE_HTTP_REFUSED"));

export const planStack = (online: boolean) =>
  Effect.gen(function* planCloudflare() {
    const planned = yield* evalStack(
      cloudflare,
      (stack) =>
        Effect.gen(function* graph() {
          yield* Effect.log(
            JSON.stringify({
              graph: Object.values(stack.resources).map((resource) => ({
                id: resource.LogicalId,
                type: resource.Type,
              })),
              stage: stack.stage,
            })
          );

          return yield* Plan.make(stack);
        }),
      { stage: "preview" }
    ).pipe(
      provideFreshArtifactStore,
      Effect.provide(
        Layer.mergeAll(
          AlchemyContextLive,
          localState(),
          layerNonInteractive()
        ).pipe(Layer.provide(NodeServices.layer))
      ),
      Effect.provideService(
        FetchHttpClient.Fetch,
        online ? fetch : offlineFetch
      ),
      Effect.map(Option.some),
      Effect.catchCause((cause) =>
        !online && Cause.pretty(cause).includes("OFFLINE_HTTP_REFUSED")
          ? Effect.succeedNone
          : Effect.failCause(cause)
      )
    );

    if (Option.isNone(planned)) {
      return yield* Effect.log(
        JSON.stringify({
          actions: "not rendered",
          graph: "built",
          note: "the stock Worker planner reads the account's workers.dev subdomain before it renders actions; offline, that read is refused. Run with MISCHIEF_ONLINE_PLAN=true and MISCHIEF_PLAN_APPROVED=true, after Joel approves, for the rendered plan",
        })
      );
    }

    const summary = Plan.describePlan(planned.value);

    const actions = Object.values(summary.resources).map(
      ({ action }) => action
    );

    if (actions.some((action) => action === "delete" || action === "replace")) {
      return yield* refuse(
        "the plan deletes or replaces a resource. Read the plan, and ask Joel before any change that drops a Durable Object namespace"
      );
    }

    return yield* Effect.log(
      JSON.stringify({ actions, resources: Object.keys(summary.resources) })
    );
  });
