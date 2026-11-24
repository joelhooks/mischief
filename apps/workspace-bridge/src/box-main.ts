import {
  NodeHttpServer,
  NodeRuntime,
  NodeServices,
} from "@effect/platform-node";
import { createServer } from "@mischief/model-bridge/server";
import { Config, Effect, Layer, Path, Redacted, Schema } from "effect";
import * as Digest from "effect/crypto/Digest";
import { HttpRouter } from "effect/http";

import { archiveDiskLayer } from "./box/archive-disk.js";
import { ArchivePort } from "./box/archive.js";
import {
  BrowserMaxLive,
  DEFAULT_BROWSER_BUILD_ROOT,
  DEFAULT_BROWSER_MAX_LIVE,
  boxImagesFromConfig,
  boxStorageFromConfig,
} from "./box/config.js";
import { boxRoutes } from "./box/http.js";
import { Boxes } from "./box/manager.js";
import { boxRunnerLayer } from "./box/runner.js";
import { notifySpend } from "./box/spend-alarm.js";
import { spendRoutes } from "./box/spend-http.js";
import { SpendLedger } from "./box/spend-ledger.js";
import { SpendLimits } from "./box/spend-protocol.js";
import { Runner } from "./runner.js";

const program = Effect.gen(function* serveBoxes() {
  const enabled = yield* Config.Literals(
    ["off", "on"],
    "MISCHIEF_PEON_BOXES"
  ).pipe(Config.withDefault("off"));

  if (enabled !== "on") {
    return yield* Effect.void;
  }

  const key = yield* Config.Redacted("MISCHIEF_BOX_KEY");

  if (Redacted.value(key).trim() === "") {
    return yield* Effect.die(
      "MISCHIEF_BOX_KEY is empty; unauthenticated control would expose full tools. Configure matching host/worker bearer keys and restart."
    );
  }

  const gid = process.getgid?.();

  if (gid === undefined) {
    return yield* Effect.die(
      "Box ownership needs a POSIX manager gid to preserve snapshot access. Run this manager on the Linux box host."
    );
  }

  const storage = yield* boxStorageFromConfig;

  const primary = yield* Config.String("MISCHIEF_BOX_ARCHIVE_PRIMARY").pipe(
    Config.withDefault("")
  );

  const replica = yield* Config.String("MISCHIEF_BOX_ARCHIVE_REPLICA").pipe(
    Config.withDefault("")
  );

  const checkerHost = yield* Config.String("MISCHIEF_BOX_ARCHIVE_HOST").pipe(
    Config.withDefault("")
  );

  const archive =
    primary === "" || replica === "" || checkerHost === ""
      ? ArchivePort.disabled
      : archiveDiskLayer({ checkerHost, replica, primary });

  const images = yield* boxImagesFromConfig;

  const browserBuildRoot = yield* Config.String(
    "MISCHIEF_BOX_BROWSER_BUILDS"
  ).pipe(Config.withDefault(DEFAULT_BROWSER_BUILD_ROOT));

  const config = {
    ...storage,
    browserBuildRoot,
    browserMaxLive: yield* Config.schema(
      BrowserMaxLive,
      "MISCHIEF_BOX_BROWSER_MAX_LIVE"
    ).pipe(Config.withDefault(DEFAULT_BROWSER_MAX_LIVE)),
    gid,
    image: images.full,
    browserImage: images.browser,
    mirrors: yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Record(Schema.String, Schema.String))
    )(yield* Config.String("MISCHIEF_BOX_MIRRORS")),
  };

  const limits = yield* Schema.decodeEffect(Schema.fromJsonString(SpendLimits))(
    yield* Config.String("MISCHIEF_BOX_SPEND_LIMITS").pipe(
      Config.withDefault("{}")
    ),
    { onExcessProperty: "error" }
  );

  const sender = yield* Config.String("MISCHIEF_BOX_SPEND_MAIL_AS").pipe(
    Config.withDefault("peons/spend-alarm")
  );

  const ratking = yield* Config.String("MISCHIEF_BOX_SPEND_MAIL_BIN").pipe(
    Config.withDefault("ratking")
  );

  const runner = boxRunnerLayer();

  const boxes = Boxes.layer(config).pipe(
    Layer.provide(archive),
    Layer.provide(runner)
  );

  const spend = Layer.unwrap(
    Effect.gen(function* boxSpendLayer() {
      yield* Boxes;
      const host = yield* Runner;
      const path = yield* Path.Path;

      return SpendLedger.layer(
        path.join(config.metadata, "model-spend.sqlite"),
        limits,
        notifySpend(host, sender, ratking)
      );
    })
  ).pipe(Layer.provide(boxes), Layer.provide(runner));

  return yield* Layer.launch(
    HttpRouter.serve(Layer.merge(boxRoutes(key), spendRoutes(key)), {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provide(Layer.merge(boxes, spend)),
      Layer.provide(
        NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 28_014 })
      ),
      Layer.provide(Layer.merge(NodeServices.layer, Digest.layerWebCrypto))
    )
  );
});

NodeRuntime.runMain(program);
