import { Effect, Layer, Option, Schema } from "effect";

import { Judge, WHY_LINE_CHARS, WHY_LINES, WhySchema } from "./judge.js";
import { StepFailed } from "./step-failed.js";
import { VerdictDeferred } from "./verdict-deferred.js";

export const SHADOW_JUDGE = "shadow/judge";

const Probability = Schema.Number.check(
  Schema.isBetween({ maximum: 1, minimum: 0 })
);

const VerdictSchema = Schema.Union([
  Schema.Struct({
    probabilities: Schema.Record(Schema.String, Probability),
    why: Schema.optionalKey(WhySchema),
  }),
  Schema.Struct({ choice: Schema.String, why: Schema.optionalKey(WhySchema) }),
]);

const decodeVerdict = Schema.decodeUnknownOption(
  Schema.fromJsonString(VerdictSchema)
);

const NO_USAGE = { tokens: 0 };

const refused = (key: string, why: string, options: readonly string[]) =>
  Effect.fail(
    new StepFailed({
      key,
      reason: `${why}. ${SHADOW_JUDGE} replies with JSON {"choice": "<option>"} or {"probabilities": {"<option>": 0..1}}, where each option is one of: ${options.join(", ")}. Either may add "why": up to ${String(WHY_LINES)} lines of at most ${String(WHY_LINE_CHARS)} characters, ids and counts only`,
    })
  );

export const shadowJudge = Layer.succeed(
  Judge,
  Judge.of({
    choose: ({ key, options, reply }) =>
      Option.match(reply, {
        onNone: () => Effect.fail(new VerdictDeferred({ to: SHADOW_JUDGE })),
        onSome: (body) =>
          Option.match(decodeVerdict(body), {
            onNone: () =>
              refused(key, "the shadow verdict did not decode", options),
            onSome: (verdict) => {
              const probabilities =
                "choice" in verdict
                  ? { [verdict.choice]: 1 }
                  : verdict.probabilities;

              const unknown = Object.keys(probabilities).filter(
                (option) => !options.includes(option)
              );

              const judgement =
                verdict.why === undefined
                  ? { probabilities, usage: NO_USAGE }
                  : { probabilities, usage: NO_USAGE, why: verdict.why };

              return unknown.length === 0
                ? Effect.succeed(judgement)
                : refused(
                    key,
                    `the shadow verdict names ${unknown.map((option) => `"${option}"`).join(", ")}, which this judge does not offer`,
                    options
                  );
            },
          }),
      }),
  })
);
