import { expect, it } from "@effect/vitest";
import { nodeSqlStorage } from "@mischief/plan-run/node";
import { Effect, Layer, Option } from "effect";

import { Mailroom, SendVerdict } from "../src/mailroom-port.js";
import type { Inbound } from "../src/mailroom-port.js";
import { postbox } from "../src/postbox.js";
import { Delivered, Runs } from "../src/runs-port.js";

const ASK = "3mxoinepzcwnl";

const world = () => {
  const storage = nodeSqlStorage(":memory:");
  const told: string[] = [];
  const surfaced: string[] = [];

  const layer = Layer.merge(
    Layer.succeed(
      Mailroom,
      Mailroom.of({
        nameOf: (did) =>
          Effect.succeed(
            did.startsWith("did:web:anon")
              ? Option.none()
              : Option.some(did.replace("did:web:", ""))
          ),
        seal: () => Effect.succeed({ envelope: "sealed", messageId: ASK }),
        send: () => Effect.succeed(SendVerdict.cases.Accepted.make({})),
        surface: (summary) =>
          Effect.sync(() => {
            surfaced.push(summary);
          }),
        tell: (to, summary, body) =>
          Effect.sync(() => {
            told.push(`${to} | ${summary} | ${body}`);
          }),
      })
    ),
    Layer.succeed(
      Runs,
      Runs.of({
        deliver: () =>
          Effect.succeed(
            Delivered.cases.Refused.make({ reason: "the run moved on" })
          ),
      })
    )
  );

  return { box: postbox(storage), layer, surfaced, told };
};

const inbound = (
  messageId: string,
  body: string,
  replyTo: Option.Option<string> = Option.none(),
  senderDid = "did:web:partner/desk"
): Inbound => ({ body, messageId, replyTo, senderDid });

it.effect(
  "an answer that names a sent ask without replying to it gets the sender one prompt with the exact reply call",
  () => {
    const { box, layer, surfaced, told } = world();

    return Effect.gen(function* prompted() {
      yield* box.seal("did:web:driver/preflight", "partner/desk", "landed?");

      yield* box.receive(
        inbound("3mxoskcw6iz56", `re your ${ASK}: #1246 squashed`),
        1
      );
      yield* box.receive(
        inbound("3mxoskcw7aaaa", `again, re ${ASK}: CI green`),
        2
      );

      expect(told).toHaveLength(1);
      expect(told[0]).toContain("partner/desk | ");
      expect(told[0]).toContain(`replyTo: "${ASK}", to: "mischief/worker"`);
      expect(surfaced[0]).toContain(
        `partner/desk was told how to reply to ${ASK}`
      );
      expect(surfaced[1]).not.toContain("was told");
    }).pipe(Effect.provide(layer));
  }
);

it.effect(
  "no prompt for an id Mischief never sent, for a reply its run refused, or for a sender with no name",
  () => {
    const { box, layer, told } = world();

    return Effect.gen(function* quiet() {
      yield* box.seal("did:web:driver/preflight", "partner/desk", "landed?");

      yield* box.receive(inbound("3mxostrangeone", "re 3mxnotoursaks"), 1);
      yield* box.receive(
        inbound("3mxoreplyrefus", `done, re ${ASK}`, Option.some(ASK)),
        2
      );
      yield* box.receive(
        inbound("3mxoanonymous1", `re ${ASK}`, Option.none(), "did:web:anon"),
        3
      );

      expect(told).toStrictEqual([]);
    }).pipe(Effect.provide(layer));
  }
);
