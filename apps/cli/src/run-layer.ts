import { Judge, Operator, RunHost, Thinker } from "@mischief/core";
import { Config, Console, Effect, Layer, Option, Path } from "effect";

import { mailOutbox } from "./mail-outbox.js";
import { runStoreFile } from "./run-store-file.js";

const runsRoot = Effect.gen(function* resolveRunsRoot() {
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

export const localRunLayer = RunHost.layer.pipe(
  Layer.provideMerge(Layer.unwrap(runsRoot.pipe(Effect.map(runStoreFile)))),
  Layer.provide(
    Layer.mergeAll(
      Thinker.unwired,
      Judge.unwired,
      Layer.unwrap(runsRoot.pipe(Effect.map(mailOutbox))),
      operatorConsole
    )
  )
);
