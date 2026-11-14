import {
  NodeHttpServer,
  NodeRuntime,
  NodeServices,
} from "@effect/platform-node";
import { createServer } from "@mischief/model-bridge/server";
import { Config, Effect, Layer, Schema } from "effect";
import { FetchHttpClient, HttpRouter } from "effect/http";

import { FullProxy, fullProxyRoutes } from "./full-proxy.js";

const program = Effect.gen(function* serveFullProxy() {
  const enabled = yield* Config.Literals(
    ["off", "on"],
    "MISCHIEF_PEON_BOXES"
  ).pipe(Config.withDefault("off"));

  if (enabled !== "on") {
    return yield* Effect.void;
  }

  const key = yield* Config.Redacted("MISCHIEF_PEON_CLIPROXY_KEY");
  const upstream = yield* Config.String("MISCHIEF_PEON_CLIPROXY_URL");

  const models = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Array(Schema.String))
  )(
    yield* Config.String("MISCHIEF_PEON_FULL_MODELS").pipe(
      Config.withDefault('["gpt-6.1-sol","claude-opus-5-5"]')
    )
  );

  return yield* Layer.launch(
    HttpRouter.serve(fullProxyRoutes, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provide(
        FullProxy.layer({ key, models, upstream }).pipe(
          Layer.provide(FetchHttpClient.layer)
        )
      ),
      Layer.provide(
        NodeHttpServer.layer(createServer, {
          host: "172.30.212.1",
          port: 28_013,
        })
      ),
      Layer.provide(NodeServices.layer)
    )
  );
});

NodeRuntime.runMain(program);
