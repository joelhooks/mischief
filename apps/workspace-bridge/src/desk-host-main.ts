import {
  NodeHttpServer,
  NodeRuntime,
  NodeServices,
} from "@effect/platform-node";
import { DESK_HOST_PORT } from "@mischief/core/desk-wake";
import { createServer } from "@mischief/model-bridge/server";
import { Config, Effect, Layer, Redacted, Schema } from "effect";
import { HttpRouter } from "effect/http";

import { deskHostRoutes } from "./desk-host-http.js";
import { DeskHost } from "./desk-host.js";
import { restoreCommand, RestoreArgv } from "./desk-restore.js";

const program = Effect.gen(function* serveDeskHost() {
  const enabled = yield* Config.Literals(
    ["off", "on"],
    "MISCHIEF_DESK_WAKE"
  ).pipe(Config.withDefault("off"));

  if (enabled !== "on") {
    return yield* Effect.void;
  }

  const key = yield* Config.Redacted("MISCHIEF_DESK_WAKE_KEY");

  if (Redacted.value(key).trim() === "") {
    return yield* Effect.die(
      "MISCHIEF_DESK_WAKE_KEY is empty. Set matching bearer keys on the Worker and desk host before starting the service."
    );
  }

  const argv = yield* Schema.decodeUnknownEffect(RestoreArgv)(
    yield* Config.String("MISCHIEF_DESK_RESTORE_CMD")
  ).pipe(
    Effect.mapError(
      () =>
        "MISCHIEF_DESK_RESTORE_CMD must be a JSON array of nonempty argv strings. Set the Muster executable or approved SSH command and restart."
    )
  );

  const exitMinutes = yield* Config.schema(
    Schema.Int.check(Schema.isGreaterThan(0)),
    "MISCHIEF_DESK_EXIT_WHEN_DRAINED"
  );

  const receipts = yield* Config.String("MISCHIEF_DESK_WAKE_RECEIPTS");

  return yield* Layer.launch(
    HttpRouter.serve(deskHostRoutes(key), {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provide(
        DeskHost.layer(receipts).pipe(
          Layer.provide(restoreCommand(argv, exitMinutes))
        )
      ),
      Layer.provide(
        NodeHttpServer.layer(createServer, {
          host: "127.0.0.1",
          port: DESK_HOST_PORT,
        })
      ),
      Layer.provide(NodeServices.layer)
    )
  );
});

NodeRuntime.runMain(program);
