import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Mail } from "@mischief/core";
import {
  Effect,
  Exit,
  FileSystem,
  Layer,
  Path,
  Schedule,
  Schema,
} from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { mailNest, NEST_SEND_TRIES } from "../src/mail-nest.js";

const FAKE_NEST = `${import.meta.dirname}/fake-nest`;

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
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const state = yield* fs.makeTempDirectoryScoped({
        prefix: "mischief-nest-",
      });

      const admitted = () => fs.readDirectory(path.join(state, "admitted"));

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

      yield* fs.writeFileString(
        path.join(state, "uncertain"),
        String(world.uncertain)
      );

      const sent = yield* Effect.exit(mail.send(call, sealed));

      if (world.uncertain >= NEST_SEND_TRIES) {
        expect(failureText(sent)).toContain(
          `Rat King did not confirm the send after ${NEST_SEND_TRIES} tries`
        );
        expect(yield* admitted()).toEqual([]);

        return;
      }

      expect(Exit.isSuccess(sent)).toBe(true);

      for (let resend = 0; resend < world.resends; resend += 1) {
        expect(
          Exit.isSuccess(yield* Effect.exit(mail.send(call, sealed)))
        ).toBe(true);
      }

      expect(yield* admitted()).toEqual([`${sealed.messageId}.json`]);
      expect(
        yield* fs.readFileString(
          path.join(state, "admitted", `${sealed.messageId}.json`)
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
        expect(yield* admitted()).toEqual([`${sealed.messageId}.json`]);
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          mailNest({
            as: "mischief/run",
            backoff: Schedule.spaced("1 millis"),
            bin: FAKE_NEST,
          }).pipe(Layer.provide(NodeServices.layer)),
          NodeServices.layer
        )
      )
    ),
  { arbitrary: { runs: 40 }, timeout: 60_000 }
);
