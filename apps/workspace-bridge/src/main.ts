import {
  NodeHttpServer,
  NodeRuntime,
  NodeServices,
} from "@effect/platform-node";
import { createServer } from "@mischief/model-bridge/server";
import { Config, Effect, Layer, Redacted } from "effect";
import { HttpRouter } from "effect/http";

import { Bridge } from "./bridge.js";
import { decodeMirrors } from "./config.js";
import { Exports } from "./exports.js";
import { bridgeRoutes } from "./http.js";
import { Runner } from "./runner.js";
import { Sandbox } from "./sandbox.js";

const program = Effect.gen(function* serveWorkspaceBridge() {
  const key = yield* Config.Redacted("MISCHIEF_WORKSPACE_BRIDGE_KEY");

  if (Redacted.value(key).trim() === "") {
    return yield* Effect.die(
      "MISCHIEF_WORKSPACE_BRIDGE_KEY is empty. Configure a nonempty bridge listen key before starting."
    );
  }

  const repos = yield* decodeMirrors(
    yield* Config.String("MISCHIEF_WORKSPACE_MIRRORS"),
    yield* Config.String("MISCHIEF_WORKSPACE_WALGIT_HOST")
  );

  const root = yield* Config.String("MISCHIEF_WORKSPACE_EXPORTS_ROOT");
  const image = yield* Config.String("MISCHIEF_WORKSPACE_IMAGE");

  const server = yield* Layer.build(
    NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 28_011 })
  );

  const runner = Runner.layer;
  const exports = Exports.layer({ repos, root }).pipe(Layer.provide(runner));

  const sandbox = Sandbox.layer(image).pipe(
    Layer.provide(exports),
    Layer.provide(runner)
  );

  const services = Bridge.layer.pipe(Layer.provide(sandbox));

  return yield* Layer.launch(
    HttpRouter.serve(bridgeRoutes(key), {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provide(services),
      Layer.provide(Layer.succeedContext(server))
    )
  );
});

NodeRuntime.runMain(
  program.pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
