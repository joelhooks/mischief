import { expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import {
  consumeDrained,
  DrainOutcomeSchema,
  UNROUTED_REASON,
} from "../../src/runs/drain.js";
import { ReplyRefused } from "../../src/runs/reply-refused.js";
import { RunReportSchema } from "../../src/runs/schema.js";
import type { ReplyLine } from "../../src/runs/schema.js";
import { InlineRunHost as RunHost } from "./inline-host.js";

const NICODEMUS_PLAIN_LINE =
  '{"body":"hello inbox","cc":[],"did":"did:web:partner.alert-cron.pi.ratking-fleet.invalid","kind":"message","messageId":"3mxmhqom4stwi","summary":"drain proof","verified":true,"from":"partner/alert-cron"}';

const decodeJsonObject = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))
);

const isString = Schema.is(Schema.String);

const Text = Schema.String.check(Schema.isMaxLength(12));

const Maybe = <S extends Schema.Top>(schema: S) =>
  Schema.UndefinedOr(Schema.Union([schema, Schema.Finite]));

const DrainedSchema = Schema.Struct({
  acceptedAt: Schema.UndefinedOr(Text),
  body: Maybe(Text),
  cc: Schema.Array(Text).check(Schema.isMaxLength(2)),
  did: Text,
  from: Schema.UndefinedOr(Text),
  kind: Schema.Literals(["message", "reply"]),
  messageId: Schema.UndefinedOr(Text),
  replyTo: Maybe(Text),
  thread: Schema.UndefinedOr(Text),
  verified: Schema.Boolean,
});

const HostSaysSchema = Schema.Union([
  Schema.Struct({ ok: RunReportSchema }),
  Schema.Struct({ refused: Text }),
  Schema.Struct({ fault: Schema.Literal(true) }),
]);

type HostSays = typeof HostSaysSchema.Type;

const unused = () => Effect.die("only deliver is used by the drain");

const stubHost = (says: HostSays, delivered: ReplyLine[]) =>
  Layer.succeed(
    RunHost,
    RunHost.of({
      abort: unused,
      advance: unused,
      answer: unused,
      deliver: (line) => {
        delivered.push(line);

        if ("ok" in says) {
          return Effect.succeed(says.ok);
        }

        return "refused" in says
          ? new ReplyRefused({ reason: says.refused, replyTo: line.replyTo })
          : Effect.die("store write failed");
      },
      extend: unused,
      inspect: unused,
      pause: unused,
      read: unused,
      resume: unused,
      revise: unused,
      submit: unused,
    })
  );

const routed = (drained: typeof DrainedSchema.Type) =>
  isString(drained.body) && isString(drained.replyTo)
    ? {
        fields: Object.fromEntries(
          Object.entries({
            acceptedAt: drained.acceptedAt,
            body: drained.body,
            from: drained.from,
            messageId: drained.messageId,
            replyTo: drained.replyTo,
          }).filter(([, value]) => value !== undefined)
        ),
        replyTo: drained.replyTo,
      }
    : undefined;

it.effect.prop(
  "a drained line reaches its run as the reply fields alone, or is kept as unrouted",
  {
    drained: Arbitrary.schema(DrainedSchema),
    garbage: Arbitrary.schema(Schema.Boolean),
    says: Arbitrary.schema(HostSaysSchema),
  },
  ({ drained, garbage, says }) =>
    Effect.gen(function* property() {
      const raw = garbage
        ? `${JSON.stringify(drained)}}`
        : JSON.stringify(drained);

      const delivered: ReplyLine[] = [];

      const exit = yield* Effect.exit(
        consumeDrained(raw).pipe(Effect.provide(stubHost(says, delivered)))
      );

      const expected = garbage ? undefined : routed(drained);

      if (expected === undefined) {
        expect(delivered).toEqual([]);
        expect(exit).toEqual(
          Exit.succeed(
            DrainOutcomeSchema.cases.Unrouted.make({
              line: raw,
              reason: UNROUTED_REASON,
            })
          )
        );

        return;
      }

      expect(delivered).toEqual([expected.fields]);

      if ("fault" in says) {
        expect(Exit.isFailure(exit)).toBe(true);

        return;
      }

      const { replyTo } = expected;

      expect(exit).toEqual(
        Exit.succeed(
          "ok" in says
            ? DrainOutcomeSchema.cases.Delivered.make({
                replyTo,
                status: says.ok.status,
              })
            : DrainOutcomeSchema.cases.Refused.make({
                reason: says.refused,
                replyTo,
              })
        )
      );
    }),
  { arbitrary: { runs: 300 } }
);

it.effect("Nicodemus's live plain message is kept as unrouted", () =>
  Effect.gen(function* example() {
    const delivered: ReplyLine[] = [];

    const outcome = yield* consumeDrained(NICODEMUS_PLAIN_LINE).pipe(
      Effect.provide(stubHost({ refused: "unused" }, delivered))
    );

    expect(delivered).toEqual([]);
    expect(outcome).toEqual(
      DrainOutcomeSchema.cases.Unrouted.make({
        line: NICODEMUS_PLAIN_LINE,
        reason: UNROUTED_REASON,
      })
    );
  })
);

it.effect("the same line as a reply hands its reply fields to the run", () =>
  Effect.gen(function* example() {
    const delivered: ReplyLine[] = [];

    const reply = JSON.stringify({
      ...decodeJsonObject(NICODEMUS_PLAIN_LINE),
      kind: "reply",
      replyTo: "t1/one#1",
      thread: "3mxmhqom4stwi",
    });

    const outcome = yield* consumeDrained(reply).pipe(
      Effect.provide(stubHost({ refused: "already delivered" }, delivered))
    );

    expect(delivered).toEqual([
      {
        body: "hello inbox",
        from: "partner/alert-cron",
        messageId: "3mxmhqom4stwi",
        replyTo: "t1/one#1",
      },
    ]);
    expect(outcome).toEqual(
      DrainOutcomeSchema.cases.Refused.make({
        reason: "already delivered",
        replyTo: "t1/one#1",
      })
    );
  })
);
