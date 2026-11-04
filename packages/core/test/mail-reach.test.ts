import { expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import {
  callerName,
  callerReach,
  mailReachReason,
} from "../src/comms/mail-reach.js";

const CALLERS = [
  ["did:web:agent-graph.driver.pi.ratking-fleet.invalid", "agent-graph/driver"],
  ["did:web:pi-durable.desk.pi.ratking-fleet.invalid", "pi-durable/desk"],
  ["did:web:switchboard.ratking-fleet.invalid", "switchboard"],
  [
    "did:web:rule-garden.garden-desk.pi.ratking-fleet.invalid",
    "rule-garden/garden-desk",
  ],
  ["did:web:drovr.drovr-desk-3.pi.ratking-fleet.invalid", "drovr/drovr-desk-3"],
  ["did:web:caboose.desk.pi.ratking-fleet.invalid", "caboose/desk"],
  ["did:web:aihero-perf.desk.pi.ratking-fleet.invalid", "aihero-perf/desk"],
] as const;

it.effect.prop(
  "the seven deployed caller DIDs derive their own names, missing grants reach only self, and explicit grants replace that reach",
  {
    caller: Arbitrary.schema(Schema.Literals(CALLERS.map(([did]) => did))),
    grants: Arbitrary.schema(
      Schema.Array(Schema.Literals(["other/desk", "joel-phone", "switchboard"]))
    ),
  },
  ({ caller, grants }) =>
    Effect.sync(() => {
      const own = CALLERS.find(([did]) => did === caller)?.[1];

      expect(Option.getOrUndefined(callerName(caller))).toBe(own);
      expect(callerReach(caller).names).toStrictEqual([own]);
      expect(mailReachReason(caller, "notify", "joel-phone")).toContain(
        "Ask the Mischief desk"
      );
      expect(
        callerReach(caller, JSON.stringify({ [caller]: grants })).names
      ).toStrictEqual(grants);
      expect(
        mailReachReason(
          caller,
          "notify",
          "joel-phone",
          JSON.stringify({ [caller]: grants })
        ) === undefined
      ).toBe(grants.includes("joel-phone"));
    })
);

it.effect("unrecognised DIDs and malformed reach never open the grant", () =>
  Effect.sync(() => {
    expect(callerReach("did:web:unknown.example.invalid").reason).toContain(
      "cannot derive"
    );
    expect(callerReach(CALLERS[0][0], "not JSON").reason).toContain(
      "MISCHIEF_MAIL_REACH"
    );
    expect(
      callerReach(
        CALLERS[0][0],
        JSON.stringify({ [CALLERS[0][0]]: ["not a name"] })
      ).reason
    ).toContain("MISCHIEF_MAIL_REACH");
  })
);
