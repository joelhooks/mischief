import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Path, Schema } from "effect";

import { buildWorker, declaration } from "../celld-build.ts";

const ConfigurationSchema = Schema.Struct({
  durable_objects: Schema.Struct({
    bindings: Schema.Array(
      Schema.Struct({ class_name: Schema.String, name: Schema.String })
    ),
  }),
  main: Schema.String,
  migrations: Schema.Array(
    Schema.Struct({
      new_sqlite_classes: Schema.Array(Schema.String),
      tag: Schema.String,
    })
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
        judge: "shadow",
        mailbox: {
          did: "did:web:mailbox.example.invalid",
          url: "http://mailbox.example.invalid",
        },
        thinker: { model: "faux" },
        version: "0.1.0",
      });

      const configuration = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(ConfigurationSchema)
      )(prepared.configuration);

      expect(configuration.name).toBe(declaration.name);
      expect(configuration.durable_objects.bindings).toEqual([
        { class_name: "PlanRun", name: "PLAN_RUN" },
        { class_name: "ServiceTokenLedger", name: "SERVICE_TOKENS" },
        { class_name: "Postbox", name: "POSTBOX" },
        { class_name: "Schedule", name: "SCHEDULE" },
      ]);
      expect(
        configuration.migrations.flatMap(
          ({ new_sqlite_classes }) => new_sqlite_classes
        )
      ).toEqual(["PlanRun", "ServiceTokenLedger", "Postbox", "Schedule"]);
      expect(Object.keys(configuration.vars).toSorted()).toEqual([
        "MISCHIEF_CALLERS",
        "MISCHIEF_DID",
        "MISCHIEF_GUARD_MS",
        "MISCHIEF_HOLD_ALARM_TO",
        "MISCHIEF_JUDGE",
        "MISCHIEF_MAILBOX_DID",
        "MISCHIEF_MAILBOX_URL",
        "MISCHIEF_MODEL",
        "MISCHIEF_THINK_CONCURRENCY",
      ]);
      expect(configuration.vars.MISCHIEF_THINK_CONCURRENCY).toBe("16");
      expect(prepared.bundle).toMatch(/export \{[^}]*\bPlanRun\b/u);
      expect(prepared.bundle).toMatch(/export \{[^}]*\bServiceTokenLedger\b/u);
      expect(prepared.bundle).toMatch(/export \{[^}]*\bPostbox\b/u);
      expect(prepared.bundle).toMatch(/export \{[^}]*\bSchedule\b/u);
      expect(prepared.bundle).not.toMatch(/from "node:/u);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000
);

it.effect(
  "a custom consumer entry builds for workerd without changing bindings, migrations or default flags",
  () =>
    Effect.gen(function* customEntry() {
      const path = yield* Path.Path;

      const prepared = yield* buildWorker({
        callers: "[]",
        commit: "0123456",
        did: "did:web:mischief.example.invalid",
        entry: path.resolve(
          import.meta.dirname,
          "../../worker/test/fixtures/call-worker.ts"
        ),
        judge: "shadow",
        mailbox: {
          did: "did:web:mailbox.example.invalid",
          url: "http://mailbox.example.invalid",
        },
        thinker: { model: "faux" },
        version: "0.1.0",
      });

      const configuration = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(ConfigurationSchema)
      )(prepared.configuration);

      expect(configuration.durable_objects).toEqual(
        declaration.durable_objects
      );
      expect(configuration.migrations).toEqual(declaration.migrations);
      expect(configuration.vars.MISCHIEF_STEP_KINDS).toBeUndefined();
      expect(configuration.vars.MISCHIEF_CALL_CONCURRENCY).toBeUndefined();
      expect(prepared.bundle).toContain("count-refs");
      expect(prepared.bundle).not.toMatch(/from "node:/u);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000
);
