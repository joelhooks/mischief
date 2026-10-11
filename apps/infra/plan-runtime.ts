// @effect-diagnostics globalFetch:off -- the offline transport is a rejecting fetch, and an approved online plan uses the platform fetch.
import { NodeCrypto, NodeServices } from "@effect/platform-node";
import { offlineLayer } from "@rat-king/alchemy-nest/offline";
import { AlchemyContextLive } from "alchemy/AlchemyContext";
import { provideFreshArtifactStore } from "alchemy/Artifacts";
import { deploy } from "alchemy/Deploy";
import { destroy } from "alchemy/Destroy";
import { layerNonInteractive } from "alchemy/Interaction";
import * as Plan from "alchemy/Plan";
import { evalStack } from "alchemy/Stack";
import type { State } from "alchemy/State";
import { localState } from "alchemy/State/LocalState";
import { Cause, Config, Effect, FileSystem, Layer, Option } from "effect";
import type { Path } from "effect";
import { FetchHttpClient } from "effect/http";

import { cloudflare } from "./alchemy.run.ts";
import { liveServices, STAGE, teardownProbe } from "./celld-ops.ts";
import { celldStack } from "./celld.ts";
import { reviewRows } from "./plan-review.ts";

const refuse = (reason: string) => Effect.die(new Error(reason));

// oxlint-disable-next-line typescript/promise-function-async -- A rejecting transport never performs I/O.
const offlineFetch: typeof fetch = () =>
  Promise.reject(new Error("OFFLINE_HTTP_REFUSED"));

export type Target = "celld" | "cloudflare";

export const planWith = (
  stack: typeof cloudflare | ReturnType<typeof celldStack>,
  online: boolean,
  state: Layer.Layer<State, never, FileSystem.FileSystem | Path.Path>,
  stage: string
) =>
  evalStack(
    stack,
    (evaluated) =>
      Effect.gen(function* graph() {
        yield* Effect.log(
          JSON.stringify({
            graph: Object.values(evaluated.resources).map((resource) => ({
              id: resource.LogicalId,
              type: resource.Type,
            })),
            stage: evaluated.stage,
          })
        );

        return yield* Plan.make(evaluated);
      }),
    { stage }
  ).pipe(
    provideFreshArtifactStore,
    Effect.provide(
      Layer.mergeAll(AlchemyContextLive, state, layerNonInteractive()).pipe(
        Layer.provide(NodeServices.layer)
      )
    ),
    Effect.provideService(FetchHttpClient.Fetch, online ? fetch : offlineFetch),
    Effect.map(Option.some),
    Effect.catchCause((cause) =>
      !online && Cause.pretty(cause).includes("OFFLINE_HTTP_REFUSED")
        ? Effect.succeedNone
        : Effect.failCause(cause)
    )
  );

export const planStack = (target: Target, online: boolean) =>
  Effect.gen(function* planTarget() {
    const planned = yield* planWith(
      target === "celld" ? celldStack(offlineLayer) : cloudflare,
      online,
      localState(),
      target === "celld" ? STAGE : "preview"
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

    const out = yield* Config.option(Config.String("MISCHIEF_PLAN_OUT"));

    if (Option.isSome(out)) {
      const fs = yield* FileSystem.FileSystem;

      const rows = yield* reviewRows(planned.value).pipe(
        Effect.provide(NodeCrypto.layer)
      );

      yield* fs.writeFileString(
        out.value,
        `${JSON.stringify(rows, null, 2)}\n`,
        {
          mode: 0o600,
        }
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

const alchemyLayer = Layer.mergeAll(
  AlchemyContextLive,
  localState(),
  layerNonInteractive()
).pipe(Layer.provide(NodeServices.layer));

export const deployCelld = (review: string) =>
  deploy({ stack: celldStack(liveServices), stage: STAGE }).pipe(
    Effect.flatMap((outputs) =>
      Effect.log(JSON.stringify({ deployed: outputs, review, stage: STAGE }))
    ),
    provideFreshArtifactStore,
    Effect.provide(alchemyLayer)
  );

export const destroyPlanCelld = evalStack(
  celldStack(offlineLayer),
  (evaluated) => Plan.destroy(evaluated),
  { stage: STAGE }
).pipe(
  Effect.flatMap((planned) =>
    Effect.log(
      JSON.stringify(
        Plan.describePlan(planned).resources.map(({ action, fqn }) => ({
          action,
          fqn,
        }))
      )
    )
  ),
  provideFreshArtifactStore,
  Effect.provide(alchemyLayer),
  Effect.provideService(FetchHttpClient.Fetch, offlineFetch)
);

export const destroyCelld = destroy({
  stack: celldStack(liveServices),
  stage: STAGE,
}).pipe(provideFreshArtifactStore, Effect.provide(alchemyLayer));

export const probeCelld = teardownProbe.pipe(
  Effect.flatMap((labels) =>
    Effect.all(
      labels.map(({ check, remaining }) =>
        Effect.log(
          remaining.length === 0
            ? `${check}_PASS`
            : `${check}_FAIL remaining: ${remaining.join(", ")}`
        )
      )
    ).pipe(
      Effect.andThen(
        labels.every(({ remaining }) => remaining.length === 0)
          ? Effect.void
          : refuse(
              `the teardown probe found Mischief resources still on the host: ${labels.flatMap(({ remaining }) => remaining).join(", ")}. Run destroy again, then probe; do not clean by hand`
            )
      )
    )
  ),
  Effect.provide(liveServices)
);
