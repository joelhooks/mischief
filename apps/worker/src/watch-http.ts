// @effect-diagnostics asyncFunction:off -- HTTP and Durable Object RPC use Promise APIs.
import { toHttpApi } from "@mischief/capability/http-api";
import { watchCapabilities, Watches, WatchRefused } from "@mischief/core";
import type { WatchSummary } from "@mischief/core";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApiBuilder, OpenApi } from "effect/http-api";

import { canonicalName } from "./fleet-names.js";
import { hashPeonText } from "./peon-crypto.js";
import { peonGranted } from "./peon-grants.js";
import type { Env } from "./plan-run-object.js";
import { watchRefusal } from "./watch-check.js";
import { validateWatch } from "./watch-engine.js";
import { WATCH_DIRECTORY, watchUnavailable } from "./watch-object.js";
import type { WatchObject } from "./watch-object.js";

const http = toHttpApi("Mischief watches", watchCapabilities);

export const watchApiSpec = () => OpenApi.fromApi(http.api);

type Reply<A> =
  | { readonly value: A }
  | { readonly refusal: typeof WatchRefused.Encoded };

const rpc = <A>(call: () => Promise<Reply<A>>) =>
  Effect.promise(call).pipe(
    Effect.flatMap((result) =>
      "refusal" in result
        ? Effect.fail(new WatchRefused(result.refusal))
        : Effect.succeed(result.value)
    )
  );

const listWatches = Effect.fn("Watch.list")(function* listWatchPage(
  binding: DurableObjectNamespace<WatchObject>,
  { owner, target }: Parameters<Watches["Service"]["listWatches"]>[0]
) {
  const directory = binding.getByName(WATCH_DIRECTORY);
  const watches: (typeof WatchSummary.Type)[] = [];
  let after: string | undefined;

  for (;;) {
    const startAfter = after;

    const page = yield* Effect.promise(
      async () => await directory.page(startAfter)
    );

    const summaries = yield* Effect.forEach(
      page,
      (key) =>
        Effect.promise(
          async () => await binding.getByName(key.slice(3)).summary()
        ),
      { concurrency: 8 }
    );

    for (const watch of summaries) {
      if (
        watch !== null &&
        (owner === undefined || owner === watch.owner) &&
        (target === undefined ||
          [...watch.notify.to, ...watch.notify.cc].some(
            (name) => canonicalName(name) === canonicalName(target)
          ))
      ) {
        watches.push(watch);
      }
    }

    after = page.at(-1);

    if (after === undefined) {
      return { watches };
    }
  }
});

const watchServices = (env: Env, owner: string): Watches["Service"] => {
  const grant = Effect.suspend(() => {
    if (!peonGranted(env.MISCHIEF_PEON_GRANTS, owner, "armWatch")) {
      return Effect.fail(
        watchRefusal(
          "NotGranted",
          "This caller has no armWatch grant. Ask the desk to add armWatch to mischief.peonCapabilities in callers.json and retry with a fresh signed request."
        )
      );
    }

    return env.WATCH === undefined
      ? Effect.fail(watchUnavailable())
      : Effect.succeed(env.WATCH);
  });

  return Watches.of({
    armWatch: ({ requestId, ...definition }) =>
      Effect.gen(function* armWatchForCaller() {
        const binding = yield* grant;

        const refusal = validateWatch(
          definition,
          env.MISCHIEF_WATCH_HTTP_HOSTS
        );

        if (refusal !== null) {
          return yield* refusal;
        }

        const id = yield* hashPeonText(JSON.stringify([owner, requestId]));
        const watchId = `watch-${id}`;
        yield* Effect.promise(async () => {
          await binding.getByName(WATCH_DIRECTORY).register(watchId);
        });

        return yield* rpc(
          async () =>
            await binding.getByName(watchId).arm(watchId, owner, definition)
        );
      }),
    listWatches: (input) =>
      grant.pipe(Effect.flatMap((binding) => listWatches(binding, input))),
    inspectWatch: ({ watchId }) =>
      grant.pipe(
        Effect.flatMap((binding) =>
          rpc(async () => await binding.getByName(watchId).inspect(owner))
        )
      ),
    cancelWatch: ({ watchId }) =>
      grant.pipe(
        Effect.flatMap((binding) =>
          rpc(
            async () =>
              await binding.getByName(watchId).stop(owner, "cancelled")
          )
        )
      ),
    completeWatch: ({ watchId }) =>
      grant.pipe(
        Effect.flatMap((binding) =>
          rpc(async () => await binding.getByName(watchId).stop(owner, "done"))
        )
      ),
  });
};

export const serveWatch = async (request: Request, env: Env, owner: string) => {
  const { handler, dispose } = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(http.api).pipe(
      Layer.provide(http.layer),
      Layer.provide(
        Layer.merge(
          Layer.succeed(Watches, watchServices(env, owner)),
          HttpServer.layerServices
        )
      )
    ),
    { disableLogger: true }
  );

  try {
    return await handler(request);
  } finally {
    await dispose();
  }
};
