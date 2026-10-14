import { expect, it } from "@effect/vitest";
import { Judge } from "@mischief/core";
import {
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Redacted,
  Schema,
} from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { HttpClient, HttpClientResponse } from "effect/http";

import { JEV_MODEL, jevJudge } from "../src/jev.js";

const KEY = "jev-test-key";

const OPTIONS = ["clean", "violations", "held", "some", "none"] as const;

const BUSY = [429, 529] as const;

const Request = Schema.Struct({
  model: Schema.String,
  questions: Schema.Struct({
    decision: Schema.Struct({
      criteria: Schema.Record(Schema.String, Schema.String),
      instructions: Schema.String,
      type: Schema.Literals(["choice", "noul"]),
    }),
  }),
  state: Schema.Struct({ docs: Schema.Record(Schema.String, Schema.String) }),
});

const criterionOf = (option: string) => `choose ${option} when it fits`;

const REPLIES = [
  "faithful",
  "extra",
  "missing",
  "not json",
  "renamed",
  "wrong type",
  "not arg-max",
  "bad sum",
  "out of range",
  "other primitive",
] as const;

const World = Schema.Struct({
  bare: Schema.Boolean,
  busy: Schema.Array(Schema.Literals(BUSY)).check(Schema.isMaxLength(7)),
  docs: Schema.Record(Schema.Literals(["inventory", "classes"]), Schema.String),
  final: Schema.Literals([200, 401, 402, 422, 500, 503]),
  options: Schema.Union([
    Schema.Array(Schema.Literals(OPTIONS)).check(
      Schema.isMinLength(2),
      Schema.isUnique()
    ),
    Schema.Literal("yes/no"),
  ]),
  reply: Schema.Literals(REPLIES),
  weights: Schema.Array(
    Schema.Int.check(Schema.isBetween({ maximum: 9, minimum: 1 }))
  ).check(Schema.isMinLength(5), Schema.isMaxLength(5)),
});

type WorldValue = typeof World.Type;

const optionsOf = (world: WorldValue): readonly string[] =>
  world.options === "yes/no" ? ["yes", "no"] : world.options;

const criteriaOf = (world: WorldValue) =>
  Object.fromEntries(
    optionsOf(world)
      .slice(world.bare ? 1 : 0)
      .map((option) => [option, criterionOf(option)])
  );

const noulOf = (world: WorldValue) => (world.weights[0] ?? 1) / 10;

const choiceAnswer = (
  reply: (typeof REPLIES)[number],
  probabilities: Readonly<Record<string, number>>
) => {
  const ranked = Object.entries(probabilities).toSorted(
    (left, right) => right[1] - left[1]
  );

  const [first, ...rest] = ranked;

  const last = ranked.at(-1);

  const variants = new Map<string, Readonly<Record<string, number>>>([
    [
      "bad sum",
      Object.fromEntries(ranked.map(([option, value]) => [option, value / 2])),
    ],
    ["extra", { ...probabilities, stranger: 0 }],
    ["missing", Object.fromEntries(rest)],
    ["out of range", { ...probabilities, [first?.[0] ?? ""]: 1.5 }],
    ["renamed", { ...Object.fromEntries(rest), stranger: first?.[1] ?? 0 }],
  ]);

  const answered = variants.get(reply) ?? probabilities;

  return {
    choice:
      reply === "not arg-max" && ranked.length > 1 && first?.[1] !== last?.[1]
        ? last?.[0]
        : first?.[0],
    confidence: 0.5,
    probabilities: answered,
    type: reply === "wrong type" ? "score" : "choice",
  };
};

const noulAnswer = (reply: (typeof REPLIES)[number], p: number) => {
  if (reply === "other primitive") {
    return choiceAnswer("faithful", { no: 1 - p, yes: p });
  }

  return {
    noul: reply === "out of range" ? 1.5 : p,
    type: reply === "wrong type" ? "score" : "noul",
  };
};

const faithfulFor = (world: WorldValue) => {
  if (world.reply === "faithful" || world.reply === "not json") {
    return world.reply === "faithful";
  }

  if (world.options === "yes/no") {
    return !["out of range", "wrong type", "other primitive"].includes(
      world.reply
    );
  }

  if (world.reply === "not arg-max") {
    const values = world.options.map((_, index) => world.weights[index] ?? 1);

    return Math.max(...values) === Math.min(...values);
  }

  return world.reply === "other primitive";
};

const outageOf = (world: WorldValue) => {
  if (world.busy.length >= 5) {
    return "busy";
  }

  if (world.final === 402) {
    return "billing";
  }

  return world.final >= 500 ? "server" : undefined;
};

const typesafe = (world: WorldValue, seen: unknown[]) => {
  let calls = 0;

  return HttpClient.make((request, url) =>
    Effect.gen(function* answer() {
      calls += 1;

      const body: unknown = Predicate.isTagged(request.body, "Uint8Array")
        ? JSON.parse(new TextDecoder().decode(request.body.body))
        : undefined;

      seen.push({
        authorization: request.headers.authorization,
        body,
        url: url.href,
      });

      const busy = world.busy[calls - 1];

      if (busy !== undefined) {
        return HttpClientResponse.fromWeb(
          request,
          new Response("{}", { status: busy })
        );
      }

      if (world.final !== 200) {
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ detail: "no" }, { status: world.final })
        );
      }

      const asked = yield* Schema.decodeUnknownEffect(Request)(body).pipe(
        Effect.orDie
      );

      const criteria = Object.keys(asked.questions.decision.criteria);

      const total = criteria.reduce(
        (sum, _, index) => sum + (world.weights[index] ?? 1),
        0
      );

      const probabilities = Object.fromEntries(
        criteria.map((option, index) => [
          option,
          (world.weights[index] ?? 1) / total,
        ])
      );

      const decision =
        asked.questions.decision.type === "noul"
          ? noulAnswer(world.reply, noulOf(world))
          : choiceAnswer(world.reply, probabilities);

      const text =
        world.reply === "not json"
          ? "<html>"
          : JSON.stringify({
              answers: { decision },
              model: "jev-1.13.0",
              usage: { input_tokens: 300, output_tokens: 20 },
            });

      return HttpClientResponse.fromWeb(
        request,
        new Response(text, { status: 200 })
      );
    })
  );
};

it.live.prop(
  "the Jev judge asks a yes/no step as one Noul and any other as one Choice, each with the step's criteria, never asks without a criterion for every transition, retries only TypeSafe's busy answers, and returns the probabilities only from a strictly well-formed answer",
  { world: Arbitrary.schema(World) },
  ({ world }) =>
    Effect.gen(function* property() {
      const seen: { authorization?: string; body: unknown; url: string }[] = [];

      const exit = yield* Effect.exit(
        Judge.use((judge) =>
          judge.choose({
            criteria: criteriaOf(world),
            docs: world.docs,
            epoch: 0,
            key: "classify_check",
            options: optionsOf(world),
            question: "Does every candidate pass the hard rules?",
            reply: Option.none(),
            runId: "sweep-1",
            visit: 1,
          })
        ).pipe(
          Effect.provide(
            jevJudge({
              apiKey: Redacted.make(KEY),
              retryBase: "1 millis",
            }).pipe(
              Layer.provide(
                Layer.succeed(HttpClient.HttpClient, typesafe(world, seen))
              )
            )
          )
        )
      );

      if (world.bare) {
        expect(seen, "a bare transition is never sent").toHaveLength(0);
        expect(Exit.isFailure(exit) ? String(exit.cause) : "").toContain(
          "reviseRun with criteria"
        );

        return;
      }

      const tries = Math.min(world.busy.length + 1, 5);

      expect(seen.length).toBe(tries);

      for (const { authorization, body, url } of seen) {
        expect([authorization, url]).toStrictEqual([
          `Bearer ${KEY}`,
          "https://api.typesafe.ai/v1/systemone",
        ]);

        expect(body).toEqual({
          model: JEV_MODEL,
          questions: {
            decision:
              world.options === "yes/no"
                ? {
                    criteria: {
                      false: criterionOf("no"),
                      true: criterionOf("yes"),
                    },
                    instructions: "Does every candidate pass the hard rules?",
                    type: "noul",
                  }
                : {
                    criteria: Object.fromEntries(
                      world.options.map((option) => [
                        option,
                        criterionOf(option),
                      ])
                    ),
                    instructions: "Does every candidate pass the hard rules?",
                    type: "choice",
                  },
          },
          state: { docs: world.docs },
        });
      }

      const succeeds =
        world.busy.length < 5 && world.final === 200 && faithfulFor(world);

      if (!succeeds) {
        expect(Exit.isFailure(exit)).toBe(true);

        const failure = Exit.isFailure(exit) ? String(exit.cause) : "";

        expect(
          failure,
          "an outage holds the run; only our key, our question or a bad answer fails the step"
        ).toContain(
          outageOf(world) === undefined ? "StepFailed" : "ProviderUnavailable"
        );

        const outage = outageOf(world);

        if (outage === undefined) {
          expect(failure).toMatch(/Resume|revise|Check/u);
        } else {
          expect(failure).toContain(outage);
        }

        return;
      }

      if (world.options === "yes/no") {
        expect(Exit.isSuccess(exit) ? exit.value : undefined).toStrictEqual({
          probabilities: { no: 1 - noulOf(world), yes: noulOf(world) },
          usage: { tokens: 320 },
        });

        return;
      }

      const total = world.options.reduce(
        (sum, _, index) => sum + (world.weights[index] ?? 1),
        0
      );

      expect(Exit.isSuccess(exit) ? exit.value : undefined).toStrictEqual({
        probabilities: Object.fromEntries(
          world.options.map((option, index) => [
            option,
            (world.weights[index] ?? 1) / total,
          ])
        ),
        usage: { tokens: 320 },
      });
    }),
  { arbitrary: { runs: 300 }, timeout: 60_000 }
);

it.live(
  "TypeSafe that never answers holds the step as a timeout instead of failing it",
  () =>
    Effect.gen(function* unreachable() {
      const clients: readonly HttpClient.HttpClient[] = [
        HttpClient.make(() => Effect.never),
      ];

      for (const client of clients) {
        const exit = yield* Effect.exit(
          Judge.use((judge) =>
            judge.choose({
              criteria: { failed: "it does not hold", passed: "it holds" },
              docs: {},
              epoch: 0,
              key: "classify_check",
              options: ["passed", "failed"],
              question: "Does it hold?",
              reply: Option.none(),
              runId: "sweep-1",
              visit: 1,
            })
          ).pipe(
            Effect.provide(
              jevJudge({
                apiKey: Redacted.make(KEY),
                patience: "20 millis",
                retryBase: "1 millis",
              }).pipe(
                Layer.provide(Layer.succeed(HttpClient.HttpClient, client))
              )
            )
          )
        );

        const failure = Exit.isFailure(exit) ? String(exit.cause) : "";

        expect(failure).toContain("ProviderUnavailable");
        expect(failure).toContain("timeout");
      }
    }),
  { timeout: 10_000 }
);
