import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, Schema } from "effect";

import { CallerGenerationRefused } from "./caller-directory.ts";
import { generateCallersFile } from "./generate-callers.ts";

const FileArg = Schema.String.check(Schema.isMinLength(1));

const Args = Schema.Union([
  Schema.Tuple([FileArg, FileArg, FileArg]),
  Schema.Tuple([FileArg, FileArg, FileArg, FileArg, FileArg]),
]);

NodeRuntime.runMain(
  Effect.gen(function* generateCallers() {
    const [directory, seed, out, reserved, extras] =
      yield* Schema.decodeUnknownEffect(Args)(process.argv.slice(2)).pipe(
        Effect.mapError(
          () =>
            new CallerGenerationRefused({
              message:
                "Use pnpm --filter @mischief/infra generate-callers <snapshot-dir-or-directory-export.json> <legacy-seed.json> <new-output.json> [<reserved-documents.json> <extra-documents.json>]",
            })
        )
      );

    const counts = yield* generateCallersFile(
      directory,
      seed,
      out,
      reserved === undefined || extras === undefined
        ? undefined
        : { reserved, extras }
    );

    yield* Console.log(JSON.stringify(counts));
  }).pipe(Effect.provide(NodeServices.layer))
);
