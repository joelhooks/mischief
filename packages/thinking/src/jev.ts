import { Judge, ProviderUnavailable, StepFailed } from "@mischief/core";
import type { ProviderCause } from "@mischief/core";
import { Effect, Layer, Predicate, Redacted, Schedule, Schema } from "effect";
import type { Duration } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";

export const JEV_MODEL = "jev-latest";

export const JEV_PATIENCE = "2 minutes";

export interface JevConfig {
  readonly apiKey: Redacted.Redacted;
  readonly patience?: Duration.Input;
  readonly retryBase?: Duration.Input;
  readonly url?: string;
}

const ChoiceAnswer = Schema.Struct({
  probabilities: Schema.Record(Schema.String, Schema.Number),
  type: Schema.Literal("choice"),
});

const Evaluation = Schema.Struct({
  answers: Schema.Struct({ decision: ChoiceAnswer }),
  usage: Schema.Struct({
    input_tokens: Schema.Int,
    output_tokens: Schema.Int,
  }),
});

const RETRYABLE = new Set([429, 529]);

class Busy extends Schema.TaggedError<Busy>()("Busy", {
  status: Schema.Int,
}) {}

const advice = (status: number) => {
  if (status === 401) {
    return "TypeSafe refused the key (401). Check the host's Jev key (mischief::typesafe_api_key) and resume the run";
  }

  if (status === 422) {
    return "TypeSafe refused the question (422). The judge step's question or its transitions are malformed; revise the plan's judge step and resume";
  }

  return `TypeSafe answered ${status}. Resume the run; if it repeats, check TypeSafe's status`;
};

export const jevJudge = ({
  apiKey,
  patience = JEV_PATIENCE,
  retryBase = "500 millis",
  url = JEV_URL,
}: JevConfig) =>
  Layer.effect(
    Judge,
    Effect.gen(function* makeJevJudge() {
      const client = yield* HttpClient.HttpClient;

      return Judge.of({
        choose: ({ docs, key, options, question }) => {
          const failed = (reason: string) => new StepFailed({ key, reason });

          const unavailable = (cause: ProviderCause, status: number | null) =>
            new ProviderUnavailable({ cause, key, provider: "jev", status });

          const refusal = (status: number) => {
            if (status === 402) {
              return unavailable("billing", status);
            }

            return status >= 500
              ? unavailable("server", status)
              : failed(advice(status));
          };

          const request = HttpClientRequest.post(url).pipe(
            HttpClientRequest.bearerToken(Redacted.value(apiKey)),
            HttpClientRequest.bodyJsonUnsafe({
              model: JEV_MODEL,
              questions: {
                decision: {
                  criteria: Object.fromEntries(
                    options.map((option) => [option, null])
                  ),
                  instructions: question,
                  type: "choice",
                },
              },
              state: { docs },
            })
          );

          return client.execute(request).pipe(
            Effect.timeout(patience),
            Effect.mapError(() => unavailable("timeout", null)),
            Effect.flatMap((response) =>
              RETRYABLE.has(response.status)
                ? Effect.fail(new Busy({ status: response.status }))
                : Effect.succeed(response)
            ),
            Effect.retry({
              schedule: Schedule.exponential(retryBase),
              times: 4,
              while: Predicate.isTagged("Busy"),
            }),
            Effect.catchTag("Busy", ({ status }) =>
              Effect.fail(unavailable("busy", status))
            ),
            Effect.flatMap((response) =>
              response.status === 200
                ? response.json.pipe(
                    Effect.mapError(() =>
                      failed("TypeSafe's answer was not JSON. Resume the run")
                    )
                  )
                : Effect.fail(refusal(response.status))
            ),
            Effect.flatMap((body) =>
              Schema.decodeUnknownEffect(Evaluation)(body).pipe(
                Effect.mapError(() =>
                  failed(
                    "TypeSafe's answer did not hold one Choice with probabilities. Resume the run; if it repeats, the API has changed"
                  )
                )
              )
            ),
            Effect.flatMap(({ answers, usage }) => {
              const returned = Object.keys(answers.decision.probabilities);

              const same =
                returned.length === options.length &&
                options.every((option) => returned.includes(option));

              return same
                ? Effect.succeed({
                    probabilities: answers.decision.probabilities,
                    usage: { tokens: usage.input_tokens + usage.output_tokens },
                  })
                : Effect.fail(
                    failed(
                      `TypeSafe answered over ${returned.join(", ")}, not this step's transitions ${options.join(", ")}. Resume the run`
                    )
                  );
            })
          );
        },
      });
    })
  );
