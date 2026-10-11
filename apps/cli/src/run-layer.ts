import { Judge, Operator, RunHost, Thinker } from "@mischief/core";
import {
  fauxThinkerOptions,
  gatewayThinkerOptions,
  piThinker,
} from "@mischief/thinking";
import {
  Config,
  Console,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
} from "effect";

import { mailOutbox } from "./mail-outbox.js";
import { runStoreFile } from "./run-store-file.js";

export const runsRoot = Effect.gen(function* resolveRunsRoot() {
  const path = yield* Path.Path;
  const configured = yield* Config.option(Config.String("MISCHIEF_RUNS"));
  const home = yield* Config.String("HOME");

  return configured.pipe(
    Option.filter((value) => value.length > 0),
    Option.getOrElse(() => path.join(home, ".mischief", "runs"))
  );
}).pipe(Effect.orDie);

const operatorConsole = Layer.succeed(Operator, {
  notify: (runId, { key, options, question }) =>
    Console.error(
      `🐀 ${runId} waits on ${key}: ${question} (${options.join(" / ")})`
    ),
});

const thinker = Layer.unwrap(
  Effect.gen(function* chooseThinker() {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;

    const model = yield* Config.String("MISCHIEF_MODEL").pipe(
      Config.withDefault("unwired")
    );

    if (model !== "faux" && model !== "gateway") {
      return Thinker.unwired;
    }

    const root = path.join(yield* runsRoot, "__thinking");

    yield* fs.makeDirectory(root, { recursive: true });

    if (model === "faux") {
      return piThinker(fauxThinkerOptions(root));
    }

    const gateway = yield* Config.all({
      apiKey: Config.Redacted("MISCHIEF_MODEL_KEY"),
      baseUrl: Config.String("MISCHIEF_MODEL_URL"),
    });

    return piThinker(gatewayThinkerOptions(root, gateway));
  }).pipe(Effect.orDie)
);

export const localRunLayer = RunHost.layer.pipe(
  Layer.provideMerge(Layer.unwrap(runsRoot.pipe(Effect.map(runStoreFile)))),
  Layer.provide(
    Layer.mergeAll(
      thinker,
      Judge.unwired,
      Layer.unwrap(runsRoot.pipe(Effect.map(mailOutbox))),
      operatorConsole
    )
  )
);
