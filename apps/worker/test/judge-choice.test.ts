import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { FetchHttpClient } from "effect/http";

import { post, prepare, start } from "./workerd.js";

const gatePlan = {
  defaults: { agent: {} },
  envelope: {
    maxAgents: 0,
    maxDepth: 3,
    maxSteps: 20,
    maxThinking: "low",
    models: ["sol"],
    names: [],
    thresholds: { judge: 0.8 },
  },
  goal: "One judged gate",
  id: "gate",
  machine: {
    id: "gate",
    initial: "gate",
    states: {
      end: { type: "final" },
      gate: {
        meta: { step: { kind: "judge", question: "Go or stop?" } },
        on: { go: { target: "end" }, stop: { target: "end" } },
      },
    },
  },
};

const brokenPlan = {
  ...gatePlan,
  machine: { ...gatePlan.machine, initial: "nowhere" },
};

const SubmitSchema = Schema.Struct({
  judge: Schema.Literals(["omitted", "shadow", "jev"]),
  valid: Schema.Boolean,
});

type Submit = typeof SubmitSchema.Type;

const ReportSchema = Schema.Struct({
  awaiting: Schema.optionalKey(
    Schema.Array(Schema.Struct({ messageId: Schema.String, to: Schema.String }))
  ),
  failures: Schema.optionalKey(
    Schema.Array(Schema.Struct({ reason: Schema.String }))
  ),
  status: Schema.String,
});

const decodeReport = Schema.decodeUnknownSync(ReportSchema);

const services = Layer.merge(NodeServices.layer, FetchHttpClient.layer);

const bodyOf = (runId: string, { judge, valid }: Submit) => {
  const plan = valid ? gatePlan : brokenPlan;

  return judge === "omitted" ? { plan, runId } : { judge, plan, runId };
};

const judgeFixedByFirstAcceptedSubmitOnAShadowHost = (
  submits: readonly Submit[]
) => {
  const first = submits.find(({ valid }) => valid);

  if (first === undefined) {
    return "none";
  }

  return first.judge === "jev" ? "jev" : "shadow";
};

it.live.prop(
  "a run keeps the judge its first accepted submit chose: refused submits and later resubmits never change it",
  {
    cases: Arbitrary.schema(
      Schema.Array(
        Schema.Array(SubmitSchema).check(
          Schema.isMinLength(1),
          Schema.isMaxLength(3)
        )
      ).check(Schema.isMinLength(1), Schema.isMaxLength(3))
    ),
  },
  ({ cases }) =>
    Effect.gen(function* judgeChoice() {
      const world = yield* prepare(30_000);

      yield* start(world);

      const violations: string[] = [];

      for (const [index, submits] of cases.entries()) {
        const runId = `judge-${String(index)}`;
        const expected = judgeFixedByFirstAcceptedSubmitOnAShadowHost(submits);

        for (const submit of submits) {
          yield* post(world, "submitPlan", bodyOf(runId, submit));
        }

        if (expected === "none") {
          const { status } = yield* post(world, "inspectRun", { runId });

          if (status !== 422 && status !== 404) {
            violations.push(
              `${runId} was only ever refused, yet inspectRun answered ${String(status)}`
            );
          }

          continue;
        }

        const report = decodeReport(
          (yield* post(world, "inspectRun", { runId })).body
        );

        if (expected === "jev") {
          const reasons = (report.failures ?? []).map(({ reason }) => reason);

          if (
            report.status !== "failed" ||
            !reasons.some((reason) => reason.includes('judge "jev"'))
          ) {
            violations.push(
              `${runId} fixed judge jev on a host without a Jev key, but ended ${report.status} with ${JSON.stringify(reasons)}`
            );
          }

          continue;
        }

        const parked = (report.awaiting ?? []).map(({ to }) => to);

        if (
          report.status !== "waiting-for-reply" ||
          parked.join(",") !== "shadow/judge"
        ) {
          violations.push(
            `${runId} fixed judge shadow, but is ${report.status} awaiting ${parked.join(",")}`
          );

          continue;
        }

        const done = decodeReport(
          (yield* post(world, "deliverReply", {
            body: '{"choice":"go"}',
            from: "shadow/judge",
            replyTo: `${runId}/gate#1`,
          })).body
        );

        if (done.status !== "done") {
          violations.push(
            `${runId} fixed judge shadow, but its shadow verdict left it ${done.status}`
          );
        }
      }

      expect(violations, violations.join("\n")).toStrictEqual([]);
    }).pipe(Effect.scoped, Effect.provide(services)),
  { arbitrary: { runs: 16 }, timeout: 180_000 }
);

it.live(
  "on a host with a Jev key, a run that chose jev is refused at submit until every judge step has criteria, naming the step; the same plan under shadow is accepted",
  () =>
    Effect.gen(function* criteriaAtSubmit() {
      const world = yield* prepare(30_000, [], "not-a-real-key-for-tests");

      yield* start(world);

      const refused = yield* post(world, "submitPlan", {
        judge: "jev",
        plan: gatePlan,
        runId: "bare-jev",
      });

      expect(refused.status).toBe(422);
      expect(JSON.stringify(refused.body)).toContain(
        'gate: judge \\"jev\\" needs criteria'
      );

      const missing = yield* post(world, "inspectRun", { runId: "bare-jev" });

      expect([404, 422]).toContain(missing.status);

      const shadow = yield* post(world, "submitPlan", {
        judge: "shadow",
        plan: gatePlan,
        runId: "bare-jev",
      });

      expect(shadow.status).toBe(200);
      expect(decodeReport(shadow.body).status).toBe("waiting-for-reply");
    }).pipe(Effect.scoped, Effect.provide(services)),
  60_000
);
