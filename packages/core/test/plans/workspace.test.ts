import { expect, it } from "@effect/vitest";
import { Effect, Exit, Match, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { checkPlan, validatePlan } from "../../src/plans/validate.js";
import {
  WorkspacePolicy,
  workspacePolicyFrom,
} from "../../src/plans/workspace.js";

const SHA = "a".repeat(40);

const REPO = "example/project";

const TOOLS = ["read", "grep", "find", "ls", "bash"];

const planOf = (
  agent: Schema.JsonObject,
  tools: readonly string[],
  inherited: boolean
) => ({
  defaults: { agent: inherited ? agent : {} },
  envelope: {
    maxAgents: 1,
    maxDepth: 2,
    maxSteps: 5,
    maxThinking: "low",
    models: ["sol"],
    names: [],
    thresholds: { judge: 0.8 },
    tools: [...tools],
  },
  id: "workspace",
  machine: {
    id: "workspace",
    initial: "work",
    states: {
      done: { type: "final" },
      work: {
        meta: {
          step: {
            agent: inherited ? {} : agent,
            kind: "think",
            prompt: "Read the code",
          },
        },
        on: { done: { target: "done" } },
      },
    },
  },
  version: 1,
});

it.effect.prop(
  "workspace acceptance requires the flag, allowlist, pinned sha, exact five tools and envelope; normalized plans keep the checkout on recheck",
  {
    badSha: Arbitrary.schema(
      Schema.Literals([
        "main",
        "abcdef0",
        "A".repeat(40),
        "g".repeat(40),
        "a".repeat(41),
      ])
    ),
    defect: Arbitrary.schema(
      Schema.Literals([
        "none",
        "flag",
        "repo",
        "sha",
        "subset",
        "extra",
        "duplicate",
        "envelope",
        "no-workspace",
      ])
    ),
    inherited: Arbitrary.schema(Schema.Boolean),
    reverse: Arbitrary.schema(Schema.Boolean),
    tool: Arbitrary.schema(Schema.Literals(TOOLS)),
  },
  ({ defect, inherited, reverse, tool, badSha }) =>
    Effect.gen(function* property() {
      const ordered = reverse ? TOOLS.toReversed() : TOOLS;

      const tools = Match.value(defect).pipe(
        Match.when("subset", () => ordered.filter((name) => name !== tool)),
        Match.when("extra", () => [...ordered, "report"]),
        Match.when("duplicate", () => [...ordered, tool]),
        Match.orElse(() => ordered)
      );

      const agent =
        defect === "no-workspace"
          ? { tools }
          : {
              tools,
              workspace: { repo: REPO, sha: defect === "sha" ? badSha : SHA },
            };

      const policy = workspacePolicyFrom(
        defect === "flag" ? "off" : "on",
        defect === "repo" ? "other/repo" : REPO
      );

      const exit = yield* Effect.exit(
        validatePlan(
          planOf(agent, defect === "envelope" ? [] : TOOLS, inherited)
        ).pipe(Effect.provideService(WorkspacePolicy, policy))
      );

      expect(Exit.isSuccess(exit), String(exit)).toBe(defect === "none");

      if (Exit.isSuccess(exit)) {
        expect(JSON.stringify(exit.value.machine.states.work)).toContain(SHA);

        const checked = yield* checkPlan(exit.value).pipe(
          Effect.provideService(WorkspacePolicy, policy)
        );

        expect(checked).toEqual(exit.value);
      } else {
        expect(String(exit.cause)).toMatch(/workspace|tool/u);
        expect(String(exit.cause)).toMatch(
          /Fix|Set|Enable|Use|Add|Replace|add/u
        );
      }
    }),
  { arbitrary: { runs: 200 } }
);

it.effect.prop(
  "shell tools need a workspace while ordinary thinks stay unchanged",
  { tool: Arbitrary.schema(Schema.Literals([...TOOLS, "report"])) },
  ({ tool }) =>
    Effect.gen(function* ordinary() {
      const exit = yield* Effect.exit(
        validatePlan(planOf({ tools: [tool] }, [tool], false))
      );

      expect(Exit.isSuccess(exit)).toBe(tool === "report");
    })
);

it.effect(
  "workspace submission defaults off even for an allowed-looking checkout",
  () =>
    Effect.gen(function* defaultsOff() {
      const exit = yield* Effect.exit(
        validatePlan(
          planOf(
            { tools: TOOLS, workspace: { repo: REPO, sha: SHA } },
            TOOLS,
            false
          )
        )
      );

      expect(Exit.isFailure(exit) && String(exit.cause)).toContain(
        "MISCHIEF_WORKSPACE=on"
      );
    })
);
