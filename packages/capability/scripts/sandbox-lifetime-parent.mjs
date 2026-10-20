import { layer as NodeServices } from "@effect/platform-node/NodeServices";
import { Effect, Layer, Predicate } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { Sandbox } from "../dist/sandbox-service.js";
import { layerSubprocess } from "../dist/sandbox-subprocess.js";

const [marker] = process.argv.slice(2);

const parent = Effect.gen(function* parent() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const observed = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, {
    ...spawner,
    spawn: (command) => {
      if (!Predicate.isTagged(command, "StandardCommand")) {
        throw new Error("Expected a standard sandbox command");
      }

      return spawner
        .spawn(
          ChildProcess.make(
            command.command,
            [...command.args, "--", marker],
            command.options
          )
        )
        .pipe(
          Effect.tap((handle) =>
            Effect.sync(() => process.stdout.write(`PID ${handle.pid}\n`))
          )
        );
    },
  });

  yield* Effect.scoped(
    Sandbox.use((sandbox) =>
      sandbox.run("tools.ready({}); await new Promise(() => {})", () =>
        Effect.sync(() => {
          process.stdout.write("READY\n");

          return { ok: true, value: null };
        })
      )
    )
  ).pipe(
    Effect.provide(
      layerSubprocess({ timeout: "60 seconds" }).pipe(Layer.provide(observed))
    )
  );
}).pipe(Effect.provide(NodeServices));

await Effect.runPromise(parent);
