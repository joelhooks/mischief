// @effect-diagnostics nodeBuiltinImport:off -- The property reads the fake nest's admitted-message files to count what Rat King would hold.
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Mail } from "@mischief/core";
import { Effect, Exit, Layer, Schedule, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { mailNest, NEST_SEND_TRIES } from "../src/mail-nest.js";

const FAKE_NEST = path.join(import.meta.dirname, "fake-nest");

const WorldSchema = Schema.Struct({
  resends: Schema.Int.check(Schema.isBetween({ maximum: 3, minimum: 0 })),
  tamper: Schema.Boolean,
  uncertain: Schema.Int.check(Schema.isBetween({ maximum: 7, minimum: 0 })),
  unknownName: Schema.Boolean,
});

const call = { epoch: 0, key: "check", runId: "run-1", visit: 1 };

const failureText = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? String(exit.cause) : "";

it.live.prop(
  "a sealed ask is admitted once, resends return its receipt, and only uncertainty past the tries or a conflict fails",
  { world: Arbitrary.schema(WorldSchema) },
  ({ world }) =>
    Effect.gen(function* property() {
      const state = mkdtempSync(path.join(tmpdir(), "mischief-nest-"));
      const admitted = () => readdirSync(path.join(state, "admitted"));

      process.env.FAKE_NEST_STATE = state;

      const mail = yield* Mail;

      const sealedExit = yield* Effect.exit(
        mail.seal({
          ...call,
          message: "ship it?",
          to: world.unknownName ? "nobody/here" : "pi-durable/desk",
        })
      );

      if (world.unknownName) {
        expect(failureText(sealedExit)).toContain(
          "nest seal exited 2: UnknownName: nobody/here"
        );

        return;
      }

      const sealed = yield* sealedExit;

      writeFileSync(path.join(state, "uncertain"), String(world.uncertain));

      const sent = yield* Effect.exit(mail.send(call, sealed));

      if (world.uncertain >= NEST_SEND_TRIES) {
        expect(failureText(sent)).toContain(
          `Rat King did not confirm the send after ${NEST_SEND_TRIES} tries`
        );
        expect(admitted()).toEqual([]);

        return;
      }

      expect(Exit.isSuccess(sent)).toBe(true);

      for (let resend = 0; resend < world.resends; resend += 1) {
        expect(
          Exit.isSuccess(yield* Effect.exit(mail.send(call, sealed)))
        ).toBe(true);
      }

      expect(admitted()).toEqual([`${sealed.messageId}.json`]);
      expect(
        readFileSync(
          path.join(state, "admitted", `${sealed.messageId}.json`),
          "utf-8"
        )
      ).toContain("mischief run-1/check#1");

      if (world.tamper) {
        const tampered = JSON.stringify({
          ...JSON.parse(sealed.envelope),
          body: "something else",
        });

        const conflict = yield* Effect.exit(
          mail.send(call, { ...sealed, envelope: tampered })
        );

        expect(failureText(conflict)).toContain(
          "Rat King refused the send as a conflict"
        );
        expect(admitted()).toEqual([`${sealed.messageId}.json`]);
      }
    }).pipe(
      Effect.provide(
        mailNest({
          as: "mischief/run",
          backoff: Schedule.spaced("1 millis"),
          bin: FAKE_NEST,
        }).pipe(Layer.provide(NodeServices.layer))
      )
    ),
  { arbitrary: { runs: 40 }, timeout: 60_000 }
);
