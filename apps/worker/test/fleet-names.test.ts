import { expect, it } from "@effect/vitest";
import { AgentName } from "@rat-king/mailbox-client";
import { Option, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import {
  RESERVED,
  canonicalName,
  didFor,
  nameFor,
} from "../src/fleet-names.js";

const reservedNames = Object.entries(RESERVED).flatMap(([key, entry]) => [
  key,
  ...("aliases" in entry ? entry.aliases : []),
]);

it("names the fleet as every Pi does: pi-durable/desk, servo and switchboard", () => {
  expect(didFor("pi-durable/desk")).toStrictEqual(
    Option.some("did:web:pi-durable.desk.pi.ratking-fleet.invalid")
  );
  expect(didFor("mischief/worker")).toStrictEqual(
    Option.some("did:web:mischief.worker.pi.ratking-fleet.invalid")
  );
  expect(didFor("servo")).toStrictEqual(
    Option.some("did:web:pennywise-owner.ratking-fleet.invalid")
  );
  expect(
    nameFor("did:web:pennywise-owner.ratking-fleet.invalid")
  ).toStrictEqual(Option.some("pennywise-owner"));
  expect(
    nameFor("did:web:agent-graph.desk.pi.ratking-fleet.invalid")
  ).toStrictEqual(Option.some("agent-graph/desk"));
  expect(didFor("Not A Name")).toStrictEqual(Option.none());
  expect(nameFor("did:web:Not_A.Name.pi.ratking-fleet.invalid")).toStrictEqual(
    Option.none()
  );
  expect(nameFor("did:web:mailbox.ratking-fleet.invalid")).toStrictEqual(
    Option.none()
  );
});

it.prop(
  "a reply's sender DID names exactly the canonical name it was sent to",
  {
    candidate: Arbitrary.schema(
      Schema.Union([AgentName, Schema.Literals(reservedNames)])
    ),
  },
  ({ candidate }) => {
    const did = didFor(candidate);

    expect(Option.isSome(did)).toBe(true);
    expect(did.pipe(Option.flatMap(nameFor))).toStrictEqual(
      Option.some(canonicalName(candidate))
    );
  },
  { arbitrary: { runs: 2000 } }
);
