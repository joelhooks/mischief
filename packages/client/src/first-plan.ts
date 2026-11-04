export const firstPlan = {
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
  goal: "Wait for an answer without mailing anyone",
  id: "first-plan",
  machine: {
    id: "first-plan",
    initial: "question",
    states: {
      done: { type: "final" },
      question: {
        meta: {
          step: { kind: "ask-joel", question: "Finish the first plan?" },
        },
        on: { no: { target: "done" }, yes: { target: "done" } },
      },
    },
  },
  version: 1,
};
