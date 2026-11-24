import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Path, Schema } from "effect";

import { buildWorker, INSTANCE } from "../celld-build.ts";

const previousBindings = [
  { class_name: "PlanRun", name: "PLAN_RUN" },
  { class_name: "ServiceTokenLedger", name: "SERVICE_TOKENS" },
  { class_name: "Postbox", name: "POSTBOX" },
  { class_name: "Schedule", name: "SCHEDULE" },
  { class_name: "CallerThinks", name: "CALLER_THINKS" },
  { class_name: "Peon", name: "PEON" },
  { class_name: "PeonTemplates", name: "PEON_TEMPLATES" },
];

const previousMigrations = [
  { new_sqlite_classes: ["PlanRun", "ServiceTokenLedger"], tag: "v1" },
  { new_sqlite_classes: ["Postbox"], tag: "v2" },
  { new_sqlite_classes: ["Schedule"], tag: "v3" },
  { new_sqlite_classes: ["CallerThinks"], tag: "v4" },
  { new_sqlite_classes: ["Peon", "PeonTemplates"], tag: "v5-peons" },
];

const bindingsWithWatch = [
  ...previousBindings,
  { class_name: "WatchObject", name: "WATCH" },
];

const migrationsWithWatch = [
  ...previousMigrations,
  { new_sqlite_classes: ["WatchObject"], tag: "v7-watch" },
];

const ConfigurationSchema = Schema.Struct({
  durable_objects: Schema.Struct({
    bindings: Schema.Array(Schema.Json),
  }),
  main: Schema.String,
  migrations: Schema.Array(Schema.Json),
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

      expect(configuration.name).toBe(INSTANCE);
      expect(configuration.durable_objects.bindings).toStrictEqual(
        bindingsWithWatch
      );
      expect(configuration.migrations).toStrictEqual(migrationsWithWatch);
      expect(configuration.vars.MISCHIEF_PEON_BOXES).toBe("off");
      expect(Object.keys(configuration.vars).toSorted()).toEqual([
        "MISCHIEF_CALLERS",
        "MISCHIEF_CALLER_THINKS",
        "MISCHIEF_DID",
        "MISCHIEF_GUARD_MS",
        "MISCHIEF_HOLD_ALARM_TO",
        "MISCHIEF_JUDGE",
        "MISCHIEF_MAILBOX_DID",
        "MISCHIEF_MAILBOX_URL",
        "MISCHIEF_MAIL_REACH",
        "MISCHIEF_MODEL",
        "MISCHIEF_PEON_BOXES",
        "MISCHIEF_PEON_GRANTS",
        "MISCHIEF_THINK_CONCURRENCY",
      ]);
      expect(configuration.vars.MISCHIEF_THINK_CONCURRENCY).toBe("16");
      expect(configuration.vars.MISCHIEF_CALLER_THINKS).toBe("40");
      expect(prepared.bundle).toMatch(/export \{[^}]*\bCallerThinks\b/u);
      expect(prepared.bundle).toMatch(/export \{[^}]*\bPlanRun\b/u);
      expect(prepared.bundle).toMatch(/export \{[^}]*\bServiceTokenLedger\b/u);
      expect(prepared.bundle).toMatch(/export \{[^}]*\bPostbox\b/u);
      expect(prepared.bundle).toMatch(/export \{[^}]*\bSchedule\b/u);
      expect(prepared.bundle).toMatch(/export \{[^}]*\bPeon\b/u);
      expect(prepared.bundle).toMatch(/export \{[^}]*\bPeonTemplates\b/u);
      expect(prepared.bundle).toMatch(/export \{[^}]*\bWatchObject\b/u);
      expect(prepared.bundle).not.toMatch(/from "node:/u);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000
);

it.effect(
  "with desk wake enabled, the built bindings and migrations match main 3fb5934 in order",
  () =>
    Effect.gen(function* deskWake() {
      const prepared = yield* buildWorker({
        callers: "[]",
        commit: "0123456",
        deskWakeSender: "did:web:operator.example.invalid",
        did: "did:web:mischief.example.invalid",
        judge: "shadow",
        mailbox: {
          did: "did:web:mailbox.example.invalid",
          url: "http://mailbox.example.invalid",
        },
        thinker: { model: "faux" },
        version: "0.1.0",
      });

      const configuration = yield* Schema.decodeEffect(
        Schema.fromJsonString(ConfigurationSchema)
      )(prepared.configuration);

      expect(configuration.durable_objects.bindings).toStrictEqual([
        ...previousBindings,
        { class_name: "DeskWaker", name: "DESK_WAKER" },
        { class_name: "WatchObject", name: "WATCH" },
      ]);
      expect(configuration.migrations).toStrictEqual([
        ...previousMigrations,
        { new_sqlite_classes: ["DeskWaker"], tag: "v6-desk-waker" },
        { new_sqlite_classes: ["WatchObject"], tag: "v7-watch" },
      ]);
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

      expect(configuration.durable_objects.bindings).toStrictEqual(
        bindingsWithWatch
      );
      expect(configuration.migrations).toStrictEqual(migrationsWithWatch);
      expect(configuration.vars.MISCHIEF_STEP_KINDS).toBeUndefined();
      expect(configuration.vars.MISCHIEF_CALL_CONCURRENCY).toBeUndefined();
      expect(prepared.bundle).toContain("count-refs");
      expect(prepared.bundle).not.toMatch(/from "node:/u);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000
);
