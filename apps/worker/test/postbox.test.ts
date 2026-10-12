import { expect, it } from "@effect/vitest";
import { nodeSqlStorage } from "@mischief/plan-run/node";
import { Effect, Fiber, Layer, Option, Result, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { TestClock } from "effect/testing";

import { Mailroom, SendVerdict } from "../src/mailroom-port.js";
import type { Inbound, SendVerdictValue } from "../src/mailroom-port.js";
import { PostboxFailed } from "../src/postbox-failed.js";
import { postbox } from "../src/postbox.js";
import { Delivered, Runs } from "../src/runs-port.js";
import type { DeliveredValue } from "../src/runs-port.js";

const Kind = Schema.Literals(["reply", "stray", "refused", "flaky"]);

const InboundSchema = Schema.Struct({
  ask: Schema.Int.check(Schema.isBetween({ maximum: 2, minimum: 0 })),
  crashBeforeAck: Schema.Boolean,
  kind: Kind,
});

const WorldSchema = Schema.Struct({
  asks: Schema.Int.check(Schema.isBetween({ maximum: 3, minimum: 1 })),
  inbound: Schema.Array(InboundSchema).check(Schema.isMaxLength(8)),
});

type World = typeof WorldSchema.Type;

const ParkedRow = Schema.Struct({ message_id: Schema.String });

interface Trace {
  readonly acked: Map<string, number>;
  readonly ackedUnsettled: string[];
  readonly journaled: Map<string, number>;
  readonly surfaced: string[];
  readonly tries: Map<string, number>;
}

const fakes = (world: World, trace: Trace, parkedIds: () => Set<string>) => {
  const kindOf = new Map<string, World["inbound"][number]["kind"]>(
    world.inbound.map(({ kind }, index) => [`in-${index}`, kind])
  );

  const mailroom = Layer.succeed(
    Mailroom,
    Mailroom.of({
      nameOf: (did) =>
        Effect.succeed(Option.some(did.replace("did:web:", "desk/"))),
      seal: (to, body) =>
        Effect.succeed({
          envelope: `${to} ${body}`,
          messageId: `tid-${body}`,
        }),
      send: (): Effect.Effect<SendVerdictValue> =>
        Effect.succeed(SendVerdict.cases.Accepted.make({})),
      surface: (summary) =>
        Effect.sync(() => {
          trace.surfaced.push(summary);
        }),
      tell: () => Effect.void,
    })
  );

  const runs = Layer.succeed(
    Runs,
    Runs.of({
      deliver: (_runId, { messageId }) =>
        Effect.suspend((): Effect.Effect<DeliveredValue, PostboxFailed> => {
          const tries = (trace.tries.get(messageId) ?? 0) + 1;

          trace.tries.set(messageId, tries);

          if (kindOf.get(messageId) === "flaky" && tries === 1) {
            return Effect.fail(new PostboxFailed({ reason: "run busy" }));
          }

          if (
            kindOf.get(messageId) === "refused" ||
            trace.journaled.has(messageId)
          ) {
            return Effect.succeed(
              Delivered.cases.Refused.make({
                reason: "the run is not waiting on it",
              })
            );
          }

          trace.journaled.set(messageId, 1);

          return Effect.succeed(Delivered.cases.Journaled.make({}));
        }),
    })
  );

  const settled = (messageId: string) =>
    trace.journaled.has(messageId) || parkedIds().has(messageId);

  return { mailroom, runs, settled };
};

const play = (world: World) =>
  Effect.gen(function* played() {
    const storage = nodeSqlStorage(":memory:");

    const box = postbox(storage);

    const trace: Trace = {
      acked: new Map(),
      ackedUnsettled: [],
      journaled: new Map(),
      surfaced: [],
      tries: new Map(),
    };

    const parkedIds = () =>
      new Set(
        storage.sql
          .exec("SELECT message_id FROM postbox_parked")
          .toArray()
          .flatMap((row) =>
            Option.toArray(Schema.decodeUnknownOption(ParkedRow)(row)).map(
              ({ message_id }) => message_id
            )
          )
      );

    const { mailroom, runs, settled } = fakes(world, trace, parkedIds);

    const sealed = yield* Effect.forEach(
      Array.from({ length: world.asks }, (_, index) => index),
      (index) => box.seal(`run-${index}`, "desk/alpha", `ask-${index}`)
    ).pipe(Effect.provide(mailroom));

    const messages: Inbound[] = world.inbound.map(({ ask, kind }, index) => ({
      body: `reply ${index}`,
      messageId: `in-${index}`,
      replyTo:
        kind === "stray"
          ? Option.some("tid-nobody")
          : Option.fromNullishOr(sealed[ask % sealed.length]?.messageId),
      senderDid: "did:web:alpha",
    }));

    const crashed = new Set<string>();

    for (let pass = 0; pass < 12; pass += 1) {
      const pending = messages.filter(
        ({ messageId }) => !trace.acked.has(messageId)
      );

      if (pending.length === 0) {
        break;
      }

      for (const [offset, message] of pending.entries()) {
        const handled = yield* Effect.result(
          box
            .receive(message, offset)
            .pipe(Effect.provide(Layer.merge(mailroom, runs)))
        );

        if (Result.isFailure(handled)) {
          break;
        }

        const index = Number(message.messageId.slice(3));

        if (
          world.inbound[index]?.crashBeforeAck === true &&
          !crashed.has(message.messageId)
        ) {
          crashed.add(message.messageId);
          break;
        }

        if (!settled(message.messageId)) {
          trace.ackedUnsettled.push(message.messageId);
        }

        trace.acked.set(
          message.messageId,
          (trace.acked.get(message.messageId) ?? 0) + 1
        );
      }
    }

    return { messages, parked: parkedIds(), sealed, trace };
  });

it.effect.prop(
  "every reply is acked once, only after its run journaled it or the Postbox parked it, and each parked reply reaches the desk once",
  { world: Arbitrary.schema(WorldSchema) },
  ({ world }) =>
    Effect.gen(function* property() {
      const { messages, parked, trace } = yield* play(world);

      expect([...trace.acked.values()]).toStrictEqual(messages.map(() => 1));
      expect(trace.ackedUnsettled).toStrictEqual([]);
      expect([...trace.journaled.values()].every((count) => count === 1)).toBe(
        true
      );
      expect(trace.surfaced.length).toBe(parked.size);

      for (const [index, { kind }] of world.inbound.entries()) {
        const id = `in-${index}`;

        expect([id, parked.has(id)]).toStrictEqual([
          id,
          kind === "stray" || kind === "refused",
        ]);
      }
    }),
  { arbitrary: { runs: 200 }, timeout: 60_000 }
);

it.effect(
  "a reply can be routed the moment the seal returns, before anything is sent",
  () =>
    Effect.gen(function* routedAtSeal() {
      const { sealed, trace } = yield* play({
        asks: 1,
        inbound: [{ ask: 0, crashBeforeAck: false, kind: "reply" }],
      });

      expect(sealed.map(({ messageId }) => messageId)).toStrictEqual([
        "tid-ask-0",
      ]);
      expect([...trace.journaled.keys()]).toStrictEqual(["in-0"]);
    })
);

const sending = (verdicts: readonly SendVerdictValue[]) => {
  const tries: string[] = [];

  const mailroom = Layer.succeed(
    Mailroom,
    Mailroom.of({
      nameOf: () => Effect.succeedNone,
      seal: () => Effect.fail(new PostboxFailed({ reason: "unused" })),
      send: (envelope) =>
        Effect.sync(() => {
          tries.push(envelope);

          return (
            verdicts[Math.min(tries.length, verdicts.length) - 1] ??
            SendVerdict.cases.Accepted.make({})
          );
        }),
      surface: () => Effect.void,
      tell: () => Effect.void,
    })
  );

  return { mailroom, tries };
};

it.effect(
  "a send is done when the mailbox accepts it or answers 409 for an id it already holds, and a refusal fails with its reason",
  () =>
    Effect.gen(function* verdicts() {
      const box = postbox(nodeSqlStorage(":memory:"));

      for (const verdict of [
        SendVerdict.cases.Accepted.make({}),
        SendVerdict.cases.Conflict.make({}),
      ] as const) {
        const { mailroom, tries } = sending([verdict]);

        yield* box.send("stored bytes").pipe(Effect.provide(mailroom));

        expect(tries).toStrictEqual(["stored bytes"]);
      }

      const refused = sending([
        SendVerdict.cases.Refused.make({ reason: "Retired" }),
      ]);

      const failure = yield* Effect.flip(
        box.send("stored bytes").pipe(Effect.provide(refused.mailroom))
      );

      expect(failure.reason).toContain("Retired");
      expect(refused.tries).toHaveLength(1);
    })
);

it.effect(
  "an unconfirmed send retries the same stored bytes three times, then fails",
  () =>
    Effect.gen(function* uncertain() {
      const box = postbox(nodeSqlStorage(":memory:"));

      const flaky = sending([
        SendVerdict.cases.Uncertain.make({ reason: "socket closed" }),
        SendVerdict.cases.Accepted.make({}),
      ]);

      const recovered = yield* box
        .send("stored bytes")
        .pipe(Effect.provide(flaky.mailroom), Effect.forkChild);

      yield* TestClock.adjust("1 minute");
      yield* Fiber.join(recovered);

      expect(flaky.tries).toStrictEqual(["stored bytes", "stored bytes"]);

      const down = sending([
        SendVerdict.cases.Uncertain.make({ reason: "socket closed" }),
      ]);

      const lost = yield* box
        .send("stored bytes")
        .pipe(Effect.provide(down.mailroom), Effect.flip, Effect.forkChild);

      yield* TestClock.adjust("1 minute");

      expect((yield* Fiber.join(lost)).reason).toContain("did not confirm");
      expect(down.tries).toHaveLength(4);
    })
);
