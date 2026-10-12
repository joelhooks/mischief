import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { buildWorker, declaration } from "../celld-build.ts";

const ConfigurationSchema = Schema.Struct({
  durable_objects: Schema.Struct({
    bindings: Schema.Array(
      Schema.Struct({ class_name: Schema.String, name: Schema.String })
    ),
  }),
  main: Schema.String,
  migrations: Schema.Array(
    Schema.Struct({ new_sqlite_classes: Schema.Array(Schema.String) })
  ),
  name: Schema.String,
  vars: Schema.Record(Schema.String, Schema.String),
});

it.effect(
  "the celld deployment builds the PlanRun worker with a SQLite class, plain vars only, and no node: imports",
  () =>
    Effect.gen(function* built() {
      const prepared = yield* buildWorker({
        callers: "[]",
        commit: "0123456",
        did: "did:web:mischief.example.invalid",
        version: "0.1.0",
      });

      const configuration = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(ConfigurationSchema)
      )(prepared.configuration);

      expect(configuration.name).toBe(declaration.name);
      expect(configuration.durable_objects.bindings).toEqual([
        { class_name: "PlanRun", name: "PLAN_RUN" },
        { class_name: "ServiceTokenLedger", name: "SERVICE_TOKENS" },
      ]);
      expect(
        configuration.migrations.flatMap(
          ({ new_sqlite_classes }) => new_sqlite_classes
        )
      ).toEqual(["PlanRun", "ServiceTokenLedger"]);
      expect(Object.keys(configuration.vars).toSorted()).toEqual([
        "MISCHIEF_CALLERS",
        "MISCHIEF_DID",
        "MISCHIEF_GUARD_MS",
        "MISCHIEF_MODEL",
      ]);
      expect(prepared.bundle).toMatch(/export \{[^}]*\bPlanRun\b/u);
      expect(prepared.bundle).toMatch(/export \{[^}]*\bServiceTokenLedger\b/u);
      expect(prepared.bundle).not.toMatch(/from "node:/u);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000
);

it.effect(
  "only a faulted build carries the send hold var",
  () =>
    Effect.gen(function* faulted() {
      const prepared = yield* buildWorker({
        callers: "[]",
        commit: "0123456",
        did: "did:web:mischief.example.invalid",
        faultHoldSeconds: 150,
        version: "0.1.0",
      });

      const configuration = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(ConfigurationSchema)
      )(prepared.configuration);

      expect(configuration.vars.MISCHIEF_FAULT_HOLD_S).toBe("150");
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000
);
