import { Effect, Layer, Option, Schema } from "effect";

import { Judge } from "./judge.js";
import { StepFailed } from "./step-failed.js";
import { VerdictDeferred } from "./verdict-deferred.js";

export const SHADOW_JUDGE = "shadow/judge";

const Probability = Schema.Number.check(
  Schema.isBetween({ maximum: 1, minimum: 0 })
);

const VerdictSchema = Schema.Union([
  Schema.Struct({ probabilities: Schema.Record(Schema.String, Probability) }),
  Schema.Struct({ choice: Schema.String }),
]);

const decodeVerdict = Schema.decodeUnknownOption(
  Schema.fromJsonString(VerdictSchema)
);

const NO_USAGE = { tokens: 0 };

export const shadowJudge = Layer.succeed(
  Judge,
  Judge.of({
    choose: ({ key, options, reply }) =>
      Option.match(reply, {
        onNone: () => Effect.fail(new VerdictDeferred({ to: SHADOW_JUDGE })),
        onSome: (body) =>
          Option.match(decodeVerdict(body), {
            onNone: () =>
              Effect.fail(
                new StepFailed({
                  key,
                  reason: `the shadow verdict did not decode. ${SHADOW_JUDGE} replies with JSON {"probabilities": {"<option>": 0..1}} or {"choice": "<option>"}, one of ${options.join(", ")}`,
                })
              ),
            onSome: (verdict) =>
              Effect.succeed({
                probabilities:
                  "choice" in verdict
                    ? { [verdict.choice]: 1 }
                    : verdict.probabilities,
                usage: NO_USAGE,
              }),
          }),
      }),
  })
);
