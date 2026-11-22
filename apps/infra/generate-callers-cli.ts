import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, Schema } from "effect";

import {
  CallerGenerationRefused,
  generateCallersFile,
} from "./generate-callers.ts";

const FileArg = Schema.String.check(Schema.isMinLength(1));

NodeRuntime.runMain(
  Effect.gen(function* generateCallers() {
    const [snapshot, seed, out] = yield* Schema.decodeUnknownEffect(
      Schema.Tuple([FileArg, FileArg, FileArg])
    )(process.argv.slice(2)).pipe(
      Effect.mapError(
        () =>
          new CallerGenerationRefused({
            message:
              "Use pnpm --filter @mischief/infra generate-callers <directory-export.json> <legacy-seed.json> <new-output.json>",
          })
      )
    );

    const counts = yield* generateCallersFile(snapshot, seed, out);
    yield* Console.log(JSON.stringify(counts));
  }).pipe(Effect.provide(NodeServices.layer))
);
