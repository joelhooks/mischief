import {
  Judge,
  missingCriteria,
  ProviderUnavailable,
  StepFailed,
} from "@mischief/core";
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

const Unit = Schema.Finite.check(Schema.isBetween({ maximum: 1, minimum: 0 }));

const ChoiceAnswer = Schema.Struct({
  choice: Schema.String,
  probabilities: Schema.Record(Schema.String, Unit),
  type: Schema.Literal("choice"),
});

const NoulAnswer = Schema.Struct({
  noul: Unit,
  type: Schema.Literal("noul"),
});

const Evaluation = Schema.Struct({
  answers: Schema.Struct({
    decision: Schema.Union([ChoiceAnswer, NoulAnswer]),
  }),
  usage: Schema.Struct({
    input_tokens: Schema.Int,
    output_tokens: Schema.Int,
  }),
});

type Answer = typeof Evaluation.Type.answers.decision;

const SUM_SLACK = 0.02;

export const isYesNo = (options: readonly string[]) =>
  options.length === 2 && options.includes("yes") && options.includes("no");

const questionOf = (
  options: readonly string[],
  criteria: Readonly<Record<string, Schema.Json>>,
  question: string
) =>
  isYesNo(options)
    ? {
        criteria: { false: criteria.no, true: criteria.yes },
        instructions: question,
        type: "noul",
      }
    : {
        criteria: Object.fromEntries(
          options.map((option) => [option, criteria[option]])
        ),
        instructions: question,
        type: "choice",
      };

export const answerProblem = (
  answer: Answer,
  options: readonly string[]
): string | undefined => {
  if (answer.type === "noul" || isYesNo(options)) {
    return (answer.type === "noul") === isYesNo(options)
      ? undefined
      : `a ${answer.type} answer to a question over ${options.join(", ")}`;
  }

  const returned = Object.keys(answer.probabilities);
  const values = Object.values(answer.probabilities);
  const total = values.reduce((sum, value) => sum + value, 0);

  if (
    returned.length !== options.length ||
    options.some((option) => !returned.includes(option))
  ) {
    return `an answer over ${returned.join(", ")}, not this step's transitions ${options.join(", ")}`;
  }

  if (Math.abs(total - 1) > SUM_SLACK) {
    return `probabilities summing to ${String(total)}, not 1`;
  }

  return answer.probabilities[answer.choice] === Math.max(...values)
    ? undefined
    : `choice ${answer.choice}, which is not its most probable option`;
};

const probabilitiesOf = (answer: Answer) =>
  answer.type === "noul"
    ? { no: 1 - answer.noul, yes: answer.noul }
    : answer.probabilities;

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
        admits: (plan) => missingCriteria(plan, "jev"),
        choose: ({ criteria = {}, docs, key, options, question }) => {
          const failed = (reason: string) => new StepFailed({ key, reason });

          const bare = options.filter((option) => !(option in criteria));

          if (bare.length > 0) {
            return Effect.fail(
              failed(
                `judge "jev" needs a criterion for every transition, and ${bare.join(", ")} has none. Fix: reviseRun with criteria on this judge step (one description per transition in on), then resume`
              )
            );
          }

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
                decision: questionOf(options, criteria, question),
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
                    "TypeSafe's answer did not hold one Choice or Noul. Resume the run; if it repeats, the API has changed"
                  )
                )
              )
            ),
            Effect.flatMap(({ answers, usage }) => {
              const problem = answerProblem(answers.decision, options);

              return problem === undefined
                ? Effect.succeed({
                    probabilities: probabilitiesOf(answers.decision),
                    usage: { tokens: usage.input_tokens + usage.output_tokens },
                  })
                : Effect.fail(
                    failed(
                      `TypeSafe answered with ${problem}. Nothing was chosen. Resume the run; if it repeats, report the answer to TypeSafe`
                    )
                  );
            })
          );
        },
      });
    })
  );
