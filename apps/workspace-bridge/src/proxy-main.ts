import {
  NodeHttpServer,
  NodeRuntime,
  NodeServices,
} from "@effect/platform-node";
import { createServer } from "@mischief/model-bridge/server";
import { Config, Effect, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpRouter } from "effect/http";

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
      Config.withDefault('["claude-opus-5-5"]')
    )
  );

  return yield* Layer.launch(
    HttpRouter.serve(proxyRoutes, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provide(
        Proxy.layer({ key, models, upstream }).pipe(
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

NodeRuntime.runMain(program);
