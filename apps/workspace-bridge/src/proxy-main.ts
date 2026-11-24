import {
  NodeHttpServer,
  NodeHttpClient,
  NodeRuntime,
  NodeServices,
} from "@effect/platform-node";
import { createServer } from "@mischief/model-bridge/server";
import { Config, Context, Effect, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpRouter } from "effect/http";

import { managerKey, modelSpend } from "./model-spend.js";
import { Proxy, proxyRoutes } from "./proxy.js";

const program = Effect.gen(function* serveWorkspaceProxy() {
  const key = yield* Config.Redacted("MISCHIEF_PEON_CLIPROXY_KEY");

  if (Redacted.value(key).trim() === "") {
    return yield* Effect.die(
      "MISCHIEF_PEON_CLIPROXY_KEY is empty. Configure the dedicated peon provider key before starting the workspace proxy."
    );
  }

  const upstream = yield* Config.String("MISCHIEF_PEON_CLIPROXY_URL");

  const models = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Array(Schema.String))
  )(
    yield* Config.String("MISCHIEF_PEON_MODELS").pipe(
      Config.withDefault('["gpt-6.1-sol","claude-opus-5-5"]')
    )
  );

  const enabled = yield* Config.Literals(
    ["off", "on"],
    "MISCHIEF_PEON_BOXES"
  ).pipe(Config.withDefault("off"));

  const manager = enabled === "on" ? yield* managerKey : undefined;

  const client = Context.get(
    yield* Layer.build(FetchHttpClient.layer),
    HttpClient.HttpClient
  );

  const spend = modelSpend(client, manager, true);

  const messagesContext = yield* Layer.build(NodeHttpClient.layerNodeHttp);
  const messagesClient = Context.get(messagesContext, HttpClient.HttpClient);

  return yield* Layer.launch(
    HttpRouter.serve(proxyRoutes, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provide(
        Proxy.layer({ key, models, spend, upstream }, messagesClient).pipe(
          Layer.provide(FetchHttpClient.layer)
        )
      ),
      Layer.provide(
        NodeHttpServer.layer(createServer, {
          host: "172.30.211.1",
          port: 28_012,
        })
      ),
      Layer.provide(NodeServices.layer)
    )
  );
});

NodeRuntime.runMain(program.pipe(Effect.scoped));
