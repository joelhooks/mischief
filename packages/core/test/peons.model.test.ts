import { expect, it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import {
  PeonEvent,
  peonIdleAlarm,
  peonTransition,
} from "../src/peons/machine.js";
import { PeonState } from "../src/peons/schema.js";
import {
  builtinPeonTemplates,
  fullPeonTemplate,
  mergePeonTemplate,
  peonCatalog,
} from "../src/peons/templates.js";

const modelStep = (
  state: typeof PeonState.Type,
  event: typeof PeonEvent.Type
): typeof PeonState.Type => {
  if (state === "destroyed") {
    return state;
  }

  if (state === "spawned") {
    if (event === "SPAWN") {
      return "attaching";
    }

    return event === "CLONE" ? "suspended" : state;
  }

  if (event === "BOX_LOST") {
    return "suspended";
  }

  if (state === "attaching" || state === "running") {
    return event === "TURN_DONE" ? "idle" : state;
  }

  if (event === "DESTROY") {
    return "destroyed";
  }

  if (state === "idle") {
    if (event === "PROMPT") {
      return "running";
    }

    if (event === "IDLE_TIMEOUT" || event === "SUSPEND") {
      return "suspended";
    }
  }

  if (event === "HIBERNATE" && state !== "hibernated") {
    return "hibernated";
  }

  if (event === "RESUME" && state !== "idle") {
    return "attaching";
  }

  return state;
};

it.prop(
  "the lifecycle follows an independent model across arbitrary legal and illegal events",
  [Arbitrary.array(Arbitrary.schema(PeonEvent), { maxLength: 100 })],
  ([events]) => {
    const states: readonly (typeof PeonState.Type)[] = [
      "spawned",
      "attaching",
      "running",
      "idle",
      "suspended",
      "hibernated",
      "destroyed",
    ];

    for (const initial of states) {
      let model = initial;
      let actual = initial;

      for (const event of events) {
        model = modelStep(model, event);
        actual = peonTransition(actual, event);
        expect(actual).toBe(model);
      }
    }
  }
);

it.prop(
  "idle and sleep have exactly one deadline; other states have none",
  [
    Arbitrary.schema(PeonState),
    Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 1_000_000, minimum: 0 }))
    ),
  ],
  ([state, idleAt]) => {
    const alarm = peonIdleAlarm(state, idleAt, fullPeonTemplate);

    if (state === "idle") {
      expect(alarm).toBe(idleAt + 60_000);
    } else if (state === "suspended") {
      expect(alarm).toBe(idleAt + 86_400_000);
    } else {
      expect(alarm).toBeNull();
    }
  }
);

it.effect.prop(
  "template resolution deep-merges limits, warm context and workspace without changing the parent",
  {
    contract: Schema.String,
    cpus: Schema.Finite.check(Schema.isBetween({ maximum: 32, minimum: 0.25 })),
    sha: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  },
  ({ contract, cpus, sha }) =>
    Effect.gen(function* merge() {
      const base = {
        ...fullPeonTemplate,
        warm: {
          contract: "Contract",
          docs: [{ path: "brief.md", text: "A task" }],
        },
        workspace: { repo: "example/project", sha: "a".repeat(40) },
      };

      const before = structuredClone(base);

      const resolved = yield* mergePeonTemplate(base, {
        limits: { cpus },
        warm: { contract },
        workspace: { sha },
      });

      expect(resolved.limits).toStrictEqual({
        cpus,
        memory: "4g",
        pids: 512,
      });
      expect(resolved.workspace).toStrictEqual({
        repo: "example/project",
        sha,
      });
      expect(resolved.warm).toStrictEqual({
        contract,
        docs: base.warm.docs,
      });
      expect(base).toStrictEqual(before);
    })
);

it.effect.prop(
  "only opus and sol may be selected by template overrides",
  { model: Schema.Union([Schema.Literals(["opus", "sol"]), Schema.String]) },
  ({ model }) =>
    Effect.gen(function* modelMap() {
      const result = yield* mergePeonTemplate(fullPeonTemplate, { model }).pipe(
        Effect.result
      );

      if (["opus", "sol"].includes(model)) {
        expect(Result.isSuccess(result)).toBe(true);
      } else {
        expect(Result.isFailure(result)).toBe(true);

        if (Result.isFailure(result)) {
          expect(result.failure.reason).toContain("opus or sol");
          expect(result.failure.reason).toContain("spawnPeon");
        }
      }
    })
);

it.effect("the pinned catalog parses and seeds every warm contract", () =>
  Effect.sync(() => {
    expect(peonCatalog.entries).toHaveLength(13);

    for (const entry of peonCatalog.entries) {
      const template = builtinPeonTemplates.find(
        ({ name }) => name === entry.template
      );

      expect(template?.extends).toStrictEqual({ name: "full", version: 1 });
      expect(template?.template.warm.contract).toContain(entry.summary);
      expect(template?.template.warm.contract).toContain(entry.verify);
      expect(template?.template.catalogModel).toBe(entry.model);
      expect(template?.template.needs).toStrictEqual(entry.needs);
    }
  })
);
