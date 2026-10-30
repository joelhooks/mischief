import {
  NodeHttpServer,
  NodeRuntime,
  NodeServices,
} from "@effect/platform-node";
import { Config, Effect, Layer, Redacted } from "effect";
import { HttpRouter } from "effect/http";

import { Bridge } from "./bridge.js";
import { bridgeRoutes } from "./http.js";
import { PiProcess } from "./pi-process.js";
import { createServer } from "./server.js";

const program = Effect.gen(function* serveBridge() {
  const key = yield* Config.Redacted("MISCHIEF_OPUS_BRIDGE_KEY");
  const cliproxyKey = yield* Config.Redacted("MISCHIEF_OPUS_CLIPROXY_KEY");

  if (
    Redacted.value(key).trim() === "" ||
    Redacted.value(cliproxyKey).trim() === ""
  ) {
    return yield* Effect.die(
      "Opus bridge credentials are empty. Set MISCHIEF_OPUS_BRIDGE_KEY and MISCHIEF_OPUS_CLIPROXY_KEY before starting the bridge."
    );
  }

  const config = {
    claude: yield* Config.String("MISCHIEF_OPUS_CLAUDE_BIN"),
    cliproxyKey,
    cliproxyUrl: yield* Config.String("MISCHIEF_OPUS_CLIPROXY_URL"),
    extension: yield* Config.String("MISCHIEF_OPUS_EXTENSION"),
    pi: yield* Config.String("MISCHIEF_OPUS_PI_BIN"),
  };

  const host = yield* Config.String("MISCHIEF_OPUS_LISTEN_HOST").pipe(
    Config.withDefault("127.0.0.1")
  );

  const port = yield* Config.Port("MISCHIEF_OPUS_LISTEN_PORT").pipe(
    Config.withDefault(28_010)
  );

  const services = Bridge.layer.pipe(Layer.provide(PiProcess.layer(config)));

  return yield* Layer.launch(
    HttpRouter.serve(bridgeRoutes(key), {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provide(services),
      Layer.provide(NodeHttpServer.layer(createServer, { host, port })),
      Layer.provide(NodeServices.layer)
    )
  );
});

NodeRuntime.runMain(program);
