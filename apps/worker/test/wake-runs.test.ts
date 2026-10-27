import { expect, it } from "@effect/vitest";
import { PlanRefused, UnknownRun, WakeUnanswered } from "@mischief/core";
import { nodeSqlStorage } from "@mischief/plan-run/node";
import { Effect, Exit, Function, Option, Schema } from "effect";

import { rememberObject } from "../src/postbox-mail.js";
import { wakeRuns } from "../src/wake-runs.js";

const AnswerSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ok") }),
  Schema.Struct({ kind: Schema.Literal("unknown-run") }),
  Schema.Struct({ kind: Schema.Literal("refused") }),
  Schema.Struct({ kind: Schema.Literal("throws") }),
  Schema.Struct({
    kind: Schema.Literal("status"),
    status: Schema.Int.check(Schema.isBetween({ maximum: 599, minimum: 201 })),
  }),
]);

type Answer = typeof AnswerSchema.Type;

const StepSchema = Schema.Literals(["abortRun", "inspectRun", "submitPlan"]);

type Step = typeof StepSchema.Type;

const responseOf = (answer: Answer) => {
  if (answer.kind === "throws") {
    throw new Error("Durable Object reset because its code was updated");
  }

  if (answer.kind === "unknown-run") {
    return Response.json(
      Schema.encodeSync(UnknownRun)(new UnknownRun({ runId: "climb-wake-1" })),
      { status: 404 }
    );
  }

  if (answer.kind === "refused") {
    return Response.json(
      Schema.encodeSync(PlanRefused)(
        new PlanRefused({ errors: ["machine has no initial state"] })
      ),
      { status: 400 }
    );
  }

  return answer.kind === "ok"
    ? Response.json({ status: "running" })
    : Response.json({ error: "boom" }, { status: answer.status });
};

const expected = (step: Step, answer: Answer): string => {
  if (answer.kind === "throws") {
    return "WakeUnanswered";
  }

  if (answer.kind === "unknown-run") {
    return step === "submitPlan" ? "WakeUnanswered" : "success";
  }

  if (answer.kind === "refused") {
    return step === "submitPlan" ? "PlanRefused" : "WakeUnanswered";
  }

  if (answer.kind === "ok") {
    return step === "inspectRun" ? "WakeUnanswered" : "success";
  }

  return "WakeUnanswered";
};

const isWakeUnanswered = Schema.is(WakeUnanswered);

it.effect.prop(
  "a run object that answers neither success, UnknownRun nor a refusal fails the wake with WakeUnanswered naming the schedule, step and run, never a defect",
  { answer: AnswerSchema, step: StepSchema },
  ({ answer, step }) =>
    Effect.gen(function* wakeAnswers() {
      const storage = nodeSqlStorage(":memory:");
      rememberObject(storage, "did:plc:alice/climb");

      const runs = wakeRuns(
        {
          get: (id: string) => ({
            // @effect-diagnostics-next-line asyncFunction:off -- the fake stub mirrors a Promise-based Durable Object fetch.
            fetch: async (request: Request) => {
              await Promise.resolve();
              expect(id).toBe("did:plc:alice/climb-wake-1");
              expect(new URL(request.url).pathname).toBe(`/${step}`);

              return responseOf(answer);
            },
          }),
          idFromName: (name) => name,
        },
        storage,
        Function.constVoid
      );

      const calls = {
        abortRun: runs.abort("climb-wake-1"),
        inspectRun: runs.inspect("climb-wake-1").pipe(Effect.asVoid),
        submitPlan: runs.submit(
          "climb-wake-1",
          {},
          {},
          { escalateTo: null, judge: null }
        ),
      } satisfies Record<Step, Effect.Effect<void, unknown>>;

      const exit = yield* Effect.exit(calls[step]);

      const outcome = Exit.isSuccess(exit)
        ? "success"
        : Option.match(Exit.findErrorOption(exit), {
            onNone: () => "defect",
            onSome: (error) => {
              if (isWakeUnanswered(error)) {
                expect(error).toMatchObject({
                  runId: "climb-wake-1",
                  scheduleId: "climb",
                  step,
                });
                expect(error.message).toContain(
                  'inspectSchedule {"scheduleId":"climb"}'
                );
              }

              return error._tag;
            },
          });

      expect(outcome).toBe(expected(step, answer));
    }),
  { arbitrary: { runs: 60 } }
);
