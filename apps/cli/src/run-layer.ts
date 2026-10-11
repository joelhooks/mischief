import { Judge, Operator, RunHost, Thinker } from "@mischief/core";
import type { Mail } from "@mischief/core";
import {
  fauxThinkerOptions,
  gatewayThinkerOptions,
  jevJudge,
  piThinker,
} from "@mischief/thinking";
import { nodeSqliteStorageFor } from "@mischief/thinking/node";
import {
  Config,
  Console,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
} from "effect";
import { FetchHttpClient } from "effect/http";
import type { ChildProcessSpawner } from "effect/process";

import { mailNest } from "./mail-nest.js";
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
      return piThinker(fauxThinkerOptions(nodeSqliteStorageFor(root)));
    }

    const gateway = yield* Config.all({
      apiKey: Config.Redacted("MISCHIEF_MODEL_KEY"),
      baseUrl: Config.String("MISCHIEF_MODEL_URL"),
    });

    return piThinker(
      gatewayThinkerOptions(nodeSqliteStorageFor(root), gateway)
    );
  }).pipe(Effect.orDie)
);

const mail = Layer.unwrap(
  Effect.gen(function* chooseMail() {
    const as = yield* Config.option(Config.String("MISCHIEF_NEST_AS"));

    const bin = yield* Config.String("MISCHIEF_NEST").pipe(
      Config.withDefault("nest")
    );

    const chosen: Layer.Layer<
      Mail,
      never,
      | ChildProcessSpawner.ChildProcessSpawner
      | FileSystem.FileSystem
      | Path.Path
    > = Option.isSome(as)
      ? mailNest({ as: as.value, bin })
      : mailOutbox(yield* runsRoot);

    return chosen;
  }).pipe(Effect.orDie)
);

const judge = Layer.unwrap(
  Effect.gen(function* chooseJudge() {
    const key = yield* Config.option(Config.Redacted("MISCHIEF_JEV_KEY"));

    return Option.match(key, {
      onNone: () => Judge.unwired,
      onSome: (apiKey) =>
        jevJudge({ apiKey }).pipe(Layer.provide(FetchHttpClient.layer)),
    });
  }).pipe(Effect.orDie)
);

export const localRunLayer = RunHost.layer.pipe(
  Layer.provideMerge(Layer.unwrap(runsRoot.pipe(Effect.map(runStoreFile)))),
  Layer.provide(Layer.mergeAll(thinker, judge, mail, operatorConsole))
);
