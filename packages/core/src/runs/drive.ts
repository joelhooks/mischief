import { Context, Effect, Layer } from "effect";

import type { RunReport } from "./schema.js";
import type { UnknownRun } from "./unknown-run.js";

export class Drive extends Context.Service<
  Drive,
  {
    readonly stored: (
      report: RunReport,
      advance: Effect.Effect<RunReport, UnknownRun>
    ) => Effect.Effect<RunReport, UnknownRun>;
  }
>()("@mischief/core/Drive") {
  static readonly inline = Layer.succeed(this, {
    stored: (_report, advance) => advance,
  });

  static readonly scheduled = (wake: Effect.Effect<void>) =>
    Layer.succeed(this, {
      stored: (report) => wake.pipe(Effect.as(report)),
    });
}
