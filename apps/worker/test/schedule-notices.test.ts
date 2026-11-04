import { expect, it } from "@effect/vitest";
// @effect-diagnostics asyncFunction:off -- the fake Postbox stands in for a Durable Object RPC stub, a Promise API.
import { nodeSqlStorage } from "@mischief/plan-run/node";
import { Effect, Option, Schema } from "effect";

import { didFor } from "../src/fleet-names.js";
import { callerOf, scheduleNotices } from "../src/schedule-notices.js";

const ID = "climb";

const KEY = `schedule-ended:${ID}`;

const OWNER = "pi-durable/desk";

const OwnerSchema = Schema.Literals([
  "pi-durable/desk",
  "agent-graph/desk",
  "not-a-fleet-did",
]);

const AttemptSchema = Schema.Struct({
  sealFails: Schema.Boolean,
  sendFails: Schema.Boolean,
});

const fakePostbox = () => {
  const seals: { readonly body: string; readonly to: string }[] = [];
  const sent: string[] = [];
  const faults = { sealFails: false, sendFails: false };

  return {
    faults,
    postbox: () => ({
      seal: async (_objectName: string, to: string, body: string) => {
        await Promise.resolve();

        if (faults.sealFails) {
          return { ok: false as const, reason: "seal refused" };
        }

        seals.push({ body, to });

        return {
          envelope: `${to}|${body}|nonce-${seals.length}`,
          messageId: `m-${seals.length}`,
          ok: true as const,
        };
      },
      send: async (envelope: string) => {
        await Promise.resolve();

        if (faults.sendFails) {
          return { ok: false as const, reason: "send refused" };
        }

        sent.push(envelope);

        return { ok: true as const };
      },
    }),
    seals,
    sent,
  };
};

const objectNameOf = (owner: string) => {
  const did =
    owner === "not-a-fleet-did"
      ? "did:web:elsewhere.invalid"
      : Option.getOrThrow(didFor(owner));

  return `${did}/${ID}`;
};

it.effect.prop(
  "an ended schedule mails its escalateTo, else the mailbox its caller's DID names, with the same bytes on every retry; a caller with no mailbox, or a Postbox that fails, never fails the end",
  {
    attempts: Schema.Array(AttemptSchema).check(Schema.isMaxLength(6)),
    escalateTo: Schema.NullOr(Schema.Literal("agent-graph/desk")),
    owner: OwnerSchema,
  },
  ({ attempts, escalateTo, owner }) =>
    Effect.gen(function* endedMail() {
      const box = fakePostbox();

      const notices = scheduleNotices({
        mailReach: () =>
          JSON.stringify({
            [objectNameOf(owner).slice(
              0,
              objectNameOf(owner).lastIndexOf("/")
            )]: ["agent-graph/desk", "pi-durable/desk"],
          }),
        objectName: () => Option.some(objectNameOf(owner)),
        postbox: box.postbox,
        storage: nodeSqlStorage(":memory:"),
      });

      const text = `Mischief schedule ${ID} ended (timeout)`;

      for (const attempt of attempts) {
        box.faults.sealFails = attempt.sealFails;
        box.faults.sendFails = attempt.sendFails;

        yield* notices.ended({ escalateTo, key: KEY, scheduleId: ID, text });
      }

      const want = owner === "not-a-fleet-did" ? null : (escalateTo ?? owner);

      const targets = new Set([
        "pi-durable/desk",
        ...(want === null ? [] : [want]),
      ]);

      for (const { body, to } of box.seals) {
        expect(targets.has(to)).toBe(true);
        expect(body).toBe(text);
      }

      expect(
        box.seals.length,
        "sealed at most once per key, however often the end is announced"
      ).toBeLessThanOrEqual(targets.size);

      expect(new Set(box.sent).size).toBeLessThanOrEqual(targets.size);

      let sealed = false;
      let delivered = false;

      for (const { sealFails, sendFails } of attempts) {
        sealed ||= !sealFails;
        delivered ||= sealed && !sendFails;
      }

      expect(box.sent.length > 0).toBe(delivered);
    }),
  { arbitrary: { runs: 200 } }
);

it.effect.prop(
  "a persisted schedule target loses reach after revocation but its desk copy still goes out with unchanged sealed bytes",
  { target: Schema.Literals(["agent-graph/desk", "joel-phone"]) },
  ({ target }) =>
    Effect.gen(function* revokedSchedule() {
      const box = fakePostbox();
      const did = "did:web:agent-graph.driver.pi.ratking-fleet.invalid";
      let config = JSON.stringify({ [did]: [target] });

      const notices = scheduleNotices({
        mailReach: () => config,
        objectName: () => Option.some(`${did}/${ID}`),
        postbox: box.postbox,
        storage: nodeSqlStorage(":memory:"),
      });

      const input = {
        escalateTo: target,
        key: KEY,
        scheduleId: ID,
        text: "ended",
      };

      yield* notices.ended(input);
      expect(box.seals.map(({ to }) => to)).toStrictEqual([
        target,
        "pi-durable/desk",
      ]);
      const originals = [...box.sent];

      config = JSON.stringify({ [did]: [] });
      yield* notices.ended(input);
      expect(box.sent).toStrictEqual([...originals, originals[1]]);
      expect(box.seals).toHaveLength(2);
    })
);

it("a schedule object name of <caller DID>/<scheduleId> names the caller's mailbox, and a DID outside the fleet names none", () => {
  expect(callerOf(objectNameOf(OWNER))).toStrictEqual(Option.some(OWNER));
  expect(callerOf(objectNameOf("not-a-fleet-did"))).toStrictEqual(
    Option.none()
  );
});
