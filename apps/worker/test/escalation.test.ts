import { expect, it } from "@effect/vitest";
import { FailureSchema, HeldSchema } from "@mischief/core";
// @effect-diagnostics asyncFunction:off -- the fake Postbox stands in for a Durable Object RPC stub, a Promise API.
import { nodeSqlStorage } from "@mischief/plan-run/node";
import { Effect, Option, Schema } from "effect";

import {
  escalate,
  escalationTargetOf,
  escalationText,
  failedText,
  heldText,
  fixEscalationAtFirstSubmit,
} from "../src/escalation.js";

const RUN = "run-1";

const OPTIONS = ["go", "stop"];

const question = (key: string) => ({
  answered: 0,
  key,
  options: OPTIONS,
  question: `Go or stop at ${key}?`,
});

const AttemptSchema = Schema.Struct({
  notice: Schema.Literals(["gate:0", "gate:1", "other:0"]),
  sealFails: Schema.Boolean,
  sendFails: Schema.Boolean,
});

type Attempt = typeof AttemptSchema.Type;

const WorldSchema = Schema.Struct({
  attempts: Schema.Array(AttemptSchema).check(Schema.isMaxLength(12)),
  target: Schema.Literals(["none", "agent-graph/desk"]),
});

const fakePostbox = () => {
  const seals: { readonly body: string; readonly to: string }[] = [];
  const sent: { readonly envelope: string; readonly notice: string }[] = [];
  const faults = { notice: "", sealFails: false, sendFails: false };

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

        sent.push({ envelope, notice: faults.notice });

        return { ok: true as const };
      },
    }),
    seals,
    sent,
  };
};

const submitted = (target: string) =>
  JSON.stringify(
    target === "none"
      ? { plan: {}, runId: RUN }
      : { escalateTo: target, plan: {}, runId: RUN }
  );

const play = (attempts: readonly Attempt[], target: string) =>
  Effect.gen(function* playAttempts() {
    const storage = nodeSqlStorage(":memory:");

    fixEscalationAtFirstSubmit(storage, submitted(target));

    const box = fakePostbox();

    for (const attempt of attempts) {
      box.faults.notice = attempt.notice;
      box.faults.sealFails = attempt.sealFails;
      box.faults.sendFails = attempt.sendFails;

      const notify = escalate({
        objectName: () => Option.some("object-1"),
        postbox: box.postbox,
        storage,
      });

      yield* notify(
        RUN,
        attempt.notice,
        escalationText(RUN, question(attempt.notice.split(":")[0] ?? ""))
      );
    }

    return box;
  });

it.effect.prop(
  "an escalation mails its named desk the same bytes on every re-announce, so a visit reaches the mailbox at most once",
  { world: WorldSchema },
  ({ world }) =>
    Effect.gen(function* escalationOnce() {
      const { seals, sent } = yield* play(world.attempts, world.target);

      if (world.target === "none") {
        expect(seals, "no escalateTo, so nothing is mailed").toStrictEqual([]);
        expect(sent).toStrictEqual([]);

        return;
      }

      for (const { body, to } of seals) {
        expect(to).toBe(world.target);
        expect(body).toContain(`answerRun {"runId": "${RUN}"`);
        expect(body).toContain(JSON.stringify(OPTIONS));
      }

      for (const notice of new Set(world.attempts.map((a) => a.notice))) {
        const envelopes = new Set(
          sent.filter((s) => s.notice === notice).map((s) => s.envelope)
        );

        expect(
          envelopes.size,
          `${notice} was re-sealed between re-announces, so the mailbox would take a second message (or refuse a conflict)`
        ).toBeLessThanOrEqual(1);

        const delivered = world.attempts.some(
          (a) => a.notice === notice && !a.sealFails && !a.sendFails
        );

        expect(envelopes.size).toBe(delivered ? 1 : envelopes.size);
      }
    }),
  { arbitrary: { runs: 200 } }
);

it.effect.prop(
  "escalateTo is fixed by the first accepted submit: a refused submit forgets it and later submits never change it",
  {
    submits: Schema.Array(
      Schema.Struct({
        accepted: Schema.Boolean,
        target: Schema.Literals(["none", "agent-graph/desk", "switchboard"]),
      })
    ).check(Schema.isMaxLength(6)),
  },
  ({ submits }) =>
    Effect.sync(() => {
      const storage = nodeSqlStorage(":memory:");

      for (const { accepted, target } of submits) {
        const forget = fixEscalationAtFirstSubmit(storage, submitted(target));

        if (!accepted) {
          forget();
        }
      }

      const first = submits.find(({ accepted }) => accepted);

      expect(Option.getOrNull(escalationTargetOf(storage))).toBe(
        first === undefined || first.target === "none" ? null : first.target
      );
    }),
  { arbitrary: { runs: 200 } }
);

it.effect.prop(
  "a hold's mail says the run is waiting-for-provider and gives resumeRun as its Fix, and a billing hold says to tell Joel",
  { held: HeldSchema },
  ({ held }) =>
    Effect.sync(() => {
      const text = heldText(RUN, held);

      expect(text).toContain("waiting-for-provider");
      expect(text).toContain(`model provider ${held.provider}`);
      expect(text).not.toContain("judge");
      expect(text).toContain(`resumeRun {"runId": "${RUN}"}`);
      expect(text).not.toContain("answerRun");
      expect(text.includes("tell Joel")).toBe(held.cause === "billing");
    }),
  { arbitrary: { runs: 100 } }
);

it.effect.prop(
  "an escalation mail names what each option means when the judge step gave criteria, and carries them in its JSON",
  {
    criteria: Schema.Struct({
      no: Schema.String.check(Schema.isPattern(/^[a-z][a-z ]{0,30}$/u)),
      yes: Schema.String.check(Schema.isPattern(/^[a-z][a-z ]{0,30}$/u)),
    }),
  },
  ({ criteria }) =>
    Effect.sync(() => {
      const text = escalationText(RUN, {
        criteria,
        key: "audit",
        options: ["yes", "no"],
        question: "Does `docs.receipt` meet the bar?",
      });

      expect(text).toContain(`- yes: ${criteria.yes}`);
      expect(text).toContain(`- no: ${criteria.no}`);
      expect(text).toContain(JSON.stringify(criteria));

      const bare = escalationText(RUN, {
        key: "audit",
        options: ["yes", "no"],
        question: "Does `docs.receipt` meet the bar?",
      });

      expect(bare).not.toContain("- yes:");
    })
);

it.effect.prop(
  "a failure's mail names the run, every failed state and its reason, and gives inspectRun and a new runId as its Fix, never resumeRun or answerRun",
  { failures: Schema.Array(FailureSchema).check(Schema.isMaxLength(4)) },
  ({ failures }) =>
    Effect.sync(() => {
      const text = failedText(RUN, failures);

      expect(text).toContain(`Mischief run ${RUN} failed`);

      for (const { key, reason } of failures) {
        expect(text).toContain(`${key}: ${reason}`);
      }

      expect(text).toContain(`inspectRun {"runId":"${RUN}"}`);
      expect(text).toContain("new runId");
      expect(text).not.toContain("resumeRun");
      expect(text).not.toContain("answerRun");
    }),
  { arbitrary: { runs: 100 } }
);
