import { expect, it } from "@effect/vitest";
import { fullPeonTemplate, PeonRefused } from "@mischief/core";
import { Effect, Schema } from "effect";

import type { PeonBox } from "../src/peon-box.js";
import { peonHost } from "../src/peon-host.js";
import type { PeonHostOptions } from "../src/peon-host.js";
import type { PeonCompleted, PeonStoredValue } from "../src/peon-state.js";

it.effect.prop(
  "every failed lifecycle call parks suspended and can resume its intent or be explicitly destroyed",
  {
    cancel: Schema.Boolean,
    kind: Schema.Literals(["suspend", "resume", "hibernate", "destroy"]),
  },
  ({ cancel, kind }) =>
    Effect.gen(function* faulted() {
      let stored: PeonStoredValue | undefined;
      let failNext = false;
      const completed = new Map<string, typeof PeonCompleted.Type>();

      const states = {
        destroy: "destroyed",
        hibernate: "hibernated",
        resume: "idle",
        suspend: "suspended",
      } as const;

      const events = {
        destroy: "DESTROY",
        hibernate: "HIBERNATE",
        resume: "RESUME",
        suspend: "SUSPEND",
      } as const;

      const box: PeonBox = {
        call: (_id, operation, _body, schema) =>
          Effect.gen(function* call() {
            if (failNext) {
              failNext = false;

              return yield* new PeonRefused({
                reason:
                  "The fake box stopped answering; inspectPeon before retrying",
              });
            }

            const state =
              operation === "inspect" ||
              operation === "spawn" ||
              operation === "prompt" ||
              operation === "clone"
                ? "idle"
                : states[operation];

            const response = {
              bytes: { home: 20, snapshot: 0, work: 10 },
              container: "box",
              lastPromptAt: null,
              image: "example/box",
              peonId: "worker-a",
              state,
              workspace: { repo: "example/project", sha: "a".repeat(40) },
            };

            return yield* Schema.decodeUnknownEffect(schema)(response).pipe(
              Effect.orDie
            );
          }),
      };

      const options: PeonHostOptions = {
        box,
        clone: () => Effect.die("this property has no clone commands"),
        guardMs: 100,
        publish: () => Effect.void,
        reply: () => Effect.void,
        reserveClone: () => Effect.void,
        storage: {
          commit: (next, _alarm, receipt) =>
            Effect.sync(() => {
              stored = structuredClone(next);

              if (receipt !== undefined) {
                completed.set(receipt.requestId, receipt.value);
              }
            }),
          completed: (id) => Effect.sync(() => completed.get(id)),
          load: Effect.sync(() => stored),
        },
      };

      const host = () => peonHost(options);
      yield* host().initialize(
        {
          owner: "did:web:driver.example.invalid",
          peonId: "worker-a",
          state: "spawned",
          template: { name: "full", version: 1 },
          updatedAt: 0,
        },
        {
          ...fullPeonTemplate,
          workspace: { repo: "example/project", sha: "a".repeat(40) },
        },
        false
      );

      if (kind === "resume") {
        yield* host().command("suspend", "setup", "SUSPEND");
      }

      failNext = true;
      yield* host()
        .command(kind, "failed-call", events[kind])
        .pipe(Effect.flip);

      const parked = yield* host().inspectStored;
      expect(parked.state).toBe("suspended");
      expect(parked.fault).toContain("stopped answering");
      expect(parked.pending?.requestId).toBe("failed-call");

      const resumed = yield* cancel
        ? host().command("destroy", "cancel-failed-call", "DESTROY")
        : host().idle();

      expect(resumed.state).toBe(cancel ? "destroyed" : states[kind]);
      expect(resumed.fault).toBeNull();
    })
);
