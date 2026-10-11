// @effect-diagnostics asyncFunction:off -- Alchemy captures cwd at import, so the stack loads by dynamic import after the state directory is selected.
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Effect, FileSystem, Layer, Path } from "effect";
import { FetchHttpClient } from "effect/http";

const refuse = (reason: string) => Effect.die(new Error(reason));

const program = Effect.gen(function* plan() {
  if ((yield* Config.String("ALCHEMY_TELEMETRY_DISABLED")) !== "1") {
    return yield* refuse(
      "set ALCHEMY_TELEMETRY_DISABLED=1; the plan sends nothing anywhere"
    );
  }

  const online = yield* Config.Boolean("MISCHIEF_ONLINE_PLAN").pipe(
    Config.withDefault(false)
  );

  const approved = yield* Config.Boolean("MISCHIEF_PLAN_APPROVED").pipe(
    Config.withDefault(false)
  );

  if (online && !approved) {
    return yield* refuse(
      "an online plan reads the Cloudflare account; set MISCHIEF_PLAN_APPROVED=true only after Joel approves account access"
    );
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(path.resolve(import.meta.dirname, "../.."));
  const directory = path.resolve(yield* Config.String("MISCHIEF_STATE_DIR"));

  if (directory === root || directory.startsWith(`${root}/`)) {
    return yield* refuse(
      "MISCHIEF_STATE_DIR is inside the repository; state must live outside it. Point it at a private directory such as ~/.local/state/mischief"
    );
  }

  yield* fs.makeDirectory(directory, { mode: 0o700, recursive: true });
  yield* fs.chmod(directory, 0o700);
  process.chdir(yield* fs.realPath(directory));

  const { planStack } = yield* Effect.promise(
    async () => await import("./plan-runtime.ts")
  );

  return yield* planStack(online);
});

NodeRuntime.runMain(
  program.pipe(
    Effect.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer))
  )
);
