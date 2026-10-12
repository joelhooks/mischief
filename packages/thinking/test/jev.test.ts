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
      criteria: Schema.Record(Schema.String, Schema.Null),
      instructions: Schema.String,
      type: Schema.Literal("choice"),
    }),
  }),
  state: Schema.Struct({ docs: Schema.Record(Schema.String, Schema.String) }),
});

const World = Schema.Struct({
  busy: Schema.Array(Schema.Literals(BUSY)).check(Schema.isMaxLength(7)),
  docs: Schema.Record(Schema.Literals(["inventory", "classes"]), Schema.String),
  final: Schema.Literals([200, 401, 422, 500]),
  options: Schema.Array(Schema.Literals(OPTIONS)).check(
    Schema.isMinLength(2),
    Schema.isUnique()
  ),
  reply: Schema.Literals([
    "faithful",
    "extra",
    "missing",
    "not json",
    "renamed",
    "wrong type",
  ]),
  weights: Schema.Array(
    Schema.Int.check(Schema.isBetween({ maximum: 9, minimum: 1 }))
  ).check(Schema.isMinLength(5), Schema.isMaxLength(5)),
});

type WorldValue = typeof World.Type;

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

      const answered = {
        extra: { ...probabilities, stranger: 0 },
        faithful: probabilities,
        missing: Object.fromEntries(Object.entries(probabilities).slice(1)),
        "not json": probabilities,
        renamed: Object.fromEntries(
          Object.entries(probabilities).map(([option, value], index) => [
            index === 0 ? "stranger" : option,
            value,
          ])
        ),
        "wrong type": probabilities,
      }[world.reply];

      const text =
        world.reply === "not json"
          ? "<html>"
          : JSON.stringify({
              answers: {
                decision: {
                  choice: criteria[0],
                  confidence: 0.5,
                  probabilities: answered,
                  type: world.reply === "wrong type" ? "score" : "choice",
                },
              },
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
  "the Jev judge asks one Choice over exactly the step's transitions, retries only TypeSafe's busy answers, and returns TypeSafe's probabilities or a failure that says what to do",
  { world: Arbitrary.schema(World) },
  ({ world }) =>
    Effect.gen(function* property() {
      const seen: { authorization?: string; body: unknown; url: string }[] = [];

      const exit = yield* Effect.exit(
        Judge.use((judge) =>
          judge.choose({
            docs: world.docs,
            epoch: 0,
            key: "classify_check",
            options: world.options,
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
            decision: {
              criteria: Object.fromEntries(
                world.options.map((option) => [option, null])
              ),
              instructions: "Does every candidate pass the hard rules?",
              type: "choice",
            },
          },
          state: { docs: world.docs },
        });
      }

      const succeeds =
        world.busy.length < 5 &&
        world.final === 200 &&
        world.reply === "faithful";

      if (!succeeds) {
        expect(Exit.isFailure(exit)).toBe(true);

        const failure = Exit.isFailure(exit) ? String(exit.cause) : "";

        expect(failure).toContain("StepFailed");

        expect(failure).toMatch(/Resume|revise|Check/u);

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
