import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { base64url, unbase64url } from "@rat-king/mailbox-client";
import { Clock, Effect, Layer, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { FetchHttpClient } from "effect/http";

import {
  bearer,
  freshCaller,
  MISCHIEF_DID,
  post,
  postAs,
  prepare,
  start,
} from "./workerd.js";
import type { Caller, Workerd } from "./workerd.js";

const P256_ORDER =
  0xff_ff_ff_ff_00_00_00_00_ff_ff_ff_ff_ff_ff_ff_ff_bc_e6_fa_ad_a7_17_9e_84_f3_b9_ca_c2_fc_63_25_51n;

const FAULTS = [
  "valid",
  "replayed",
  "foreign key",
  "unknown caller",
  "other audience",
  "bare audience",
  "other capability",
  "expired",
  "issued later",
  "lives too long",
  "high S",
  "no token",
  "not a JWT",
] as const;

type Fault = (typeof FAULTS)[number];

const services = Layer.merge(NodeServices.layer, FetchHttpClient.layer);

const highS = (authorization: string) => {
  const [header = "", claims = "", signature = ""] = authorization
    .replace("Bearer ", "")
    .split(".");

  const bytes = unbase64url(signature);

  const s = BigInt(
    `0x${Array.from(bytes.subarray(32), (byte) => byte.toString(16).padStart(2, "0")).join("")}`
  );

  const flipped = (P256_ORDER - s).toString(16).padStart(64, "0");

  const high = Uint8Array.from([
    ...bytes.subarray(0, 32),
    ...(flipped.match(/../gu) ?? []).map((pair) => Number.parseInt(pair, 16)),
  ]);

  return `Bearer ${header}.${claims}.${base64url(high)}`;
};

interface Cast {
  readonly alice: Caller;
  readonly mallory: Caller;
}

const AUTHORIZATIONS: Record<
  Fault,
  (cast: Cast, now: number) => Effect.Effect<string>
> = {
  "bare audience": ({ alice }) =>
    bearer(alice, "inspectRun", { aud: MISCHIEF_DID }),
  expired: ({ alice }, now) =>
    bearer(alice, "inspectRun", { exp: now - 1, iat: now - 31 }),
  "foreign key": ({ alice, mallory }) =>
    bearer({ ...alice, key: mallory.key }, "inspectRun"),
  "high S": ({ alice }) => bearer(alice, "inspectRun").pipe(Effect.map(highS)),
  "issued later": ({ alice }, now) =>
    bearer(alice, "inspectRun", { exp: now + 40, iat: now + 10 }),
  "lives too long": ({ alice }, now) =>
    bearer(alice, "inspectRun", { exp: now + 61, iat: now }),
  "no token": () => Effect.succeed(""),
  "not a JWT": () => Effect.succeed("Bearer not-a-token"),
  "other audience": ({ alice }) =>
    bearer(alice, "inspectRun", {
      aud: "did:web:other.ratking-fleet.invalid#mischief",
    }),
  "other capability": ({ alice }) =>
    bearer(alice, "inspectRun", { lxm: "sh.mschf.mischief.submitPlan" }),
  replayed: ({ alice }) => bearer(alice, "inspectRun"),
  "unknown caller": ({ mallory }) => bearer(mallory, "inspectRun"),
  valid: ({ alice }) => bearer(alice, "inspectRun"),
};

const inspect = (world: Workerd, authorization: string) =>
  postAs(world, "inspectRun", { runId: "line" }, authorization).pipe(
    Effect.map(({ status }) => status)
  );

it.live.prop(
  "the Worker serves a Rat King service token once, from a listed caller, signed by its key in low-S form, for this host and this capability, inside its window",
  {
    faults: Arbitrary.schema(
      Schema.Array(Schema.Literals(FAULTS)).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(6)
      )
    ),
  },
  ({ faults }) =>
    Effect.gen(function* property() {
      const alice = yield* freshCaller("alice");
      const mallory = yield* freshCaller("mallory");
      const world = yield* prepare(30_000, [alice]);

      yield* start(world);

      for (const fault of faults) {
        const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);

        const authorization = yield* AUTHORIZATIONS[fault](
          { alice, mallory },
          now
        );

        const first = yield* inspect(world, authorization);

        if (fault === "valid" || fault === "replayed") {
          expect(first).not.toBe(401);
        } else {
          expect([fault, first]).toStrictEqual([fault, 401]);
        }

        if (fault === "replayed") {
          expect(yield* inspect(world, authorization)).toBe(401);
        }
      }
    }).pipe(Effect.scoped, Effect.provide(services)),
  { arbitrary: { runs: 8 }, timeout: 180_000 }
);

const PlanSchema = Schema.Struct({
  plan: Schema.Struct({ id: Schema.String }),
});

const thinkPlan = {
  defaults: { agent: {} },
  envelope: {
    maxAgents: 1,
    maxDepth: 3,
    maxSteps: 10,
    maxThinking: "low",
    models: ["sol"],
    names: [],
    thresholds: { judge: 0.8 },
  },
  goal: "Think once",
  id: "alices-plan",
  machine: {
    id: "alices-plan",
    initial: "think",
    states: {
      done: { type: "final" },
      think: {
        meta: { step: { kind: "think", prompt: "think", writes: "thought" } },
        on: { done: { target: "done" } },
      },
    },
  },
};

it.live(
  "one caller's run is invisible to another caller under the same run id, and each caller can run its own",
  () =>
    Effect.gen(function* desks() {
      const alice = yield* freshCaller("alice");
      const bob = yield* freshCaller("bob");
      const world = yield* prepare(30_000, [alice, bob]);

      yield* start(world);

      const submitted = yield* post(
        world,
        "submitPlan",
        { plan: thinkPlan, runId: "shared" },
        alice
      );

      expect(submitted.status).toBe(200);

      const own = yield* post(world, "readRun", { runId: "shared" }, alice);

      const read = yield* Schema.decodeUnknownEffect(PlanSchema)(own.body);

      expect(read.plan.id).toBe("alices-plan");

      const other = yield* post(world, "readRun", { runId: "shared" }, bob);

      expect(other.status).not.toBe(200);

      expect(JSON.stringify(other.body)).not.toContain("alices-plan");

      const bobs = yield* post(
        world,
        "submitPlan",
        {
          plan: {
            ...thinkPlan,
            id: "bobs-plan",
            machine: { ...thinkPlan.machine, id: "bobs-plan" },
          },
          runId: "shared",
        },
        bob
      );

      expect(bobs.status).toBe(200);
    }).pipe(Effect.scoped, Effect.provide(services)),
  60_000
);
