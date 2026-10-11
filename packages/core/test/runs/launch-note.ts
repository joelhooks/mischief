export const launchNoteSeed = {
  brief: "Mischief runs durable agent plans",
};

export const launchNotePlan = {
  defaults: {
    agent: {
      model: "luna",
      thinking: "low",
    },
    placement: "child",
  },
  envelope: {
    budgetTokens: 50_000,
    maxAgents: 6,
    maxDepth: 2,
    maxSteps: 20,
    maxThinking: "high",
    models: ["sol", "luna", "haiku"],
    names: ["rats-nest/desk"],
    thresholds: {
      judge: 0.7,
    },
    tools: ["web.search"],
  },
  goal: "Write and ship a launch note for mischief",
  id: "launch-note",
  machine: {
    id: "launch-note",
    initial: "research",
    states: {
      assess: {
        meta: {
          step: {
            kind: "judge",
            question: "Is the research enough to write from?",
            reads: ["product_summary", "audience"],
          },
        },
        on: {
          enough: {
            target: "draft",
          },
          thin: {
            target: "research",
          },
        },
      },
      draft: {
        meta: {
          step: {
            goal: "Write the note and get it reviewed",
            kind: "sketch",
            next: "ship_check",
          },
        },
      },
      held: {
        type: "final",
      },
      publish: {
        meta: {
          step: {
            kind: "ask-joel",
            question: "Publish the launch note?",
          },
        },
        on: {
          approve: {
            target: "shipped",
          },
          hold: {
            target: "held",
          },
        },
      },
      research: {
        meta: {
          step: {
            branches: {
              audience: {
                initial: "gather",
                states: {
                  done: {
                    type: "final",
                  },
                  gather: {
                    meta: {
                      step: {
                        agent: {
                          tools: ["web.search"],
                        },
                        kind: "think",
                        prompt: "Find who mischief is for",
                        writes: "audience",
                      },
                    },
                    on: {
                      done: {
                        target: "done",
                      },
                    },
                  },
                },
              },
              product: {
                initial: "gather",
                states: {
                  done: {
                    type: "final",
                  },
                  gather: {
                    meta: {
                      step: {
                        agent: {
                          tools: ["web.search"],
                        },
                        kind: "think",
                        prompt: "Gather what mischief does",
                        writes: "product",
                      },
                    },
                    on: {
                      done: {
                        target: "summarize",
                      },
                    },
                  },
                  summarize: {
                    meta: {
                      step: {
                        kind: "think",
                        prompt: "Summarize the product notes in three lines",
                        writes: "product_summary",
                      },
                    },
                    on: {
                      done: {
                        target: "done",
                      },
                    },
                  },
                },
              },
            },
            join: "allSettled",
            kind: "parallel",
          },
        },
        on: {
          done: {
            target: "assess",
          },
          failed: {
            target: "assess",
          },
        },
      },
      ship_check: {
        meta: {
          step: {
            kind: "judge",
            question: "Is the note ready to publish?",
            reads: ["brief", "note"],
          },
        },
        on: {
          revise: {
            target: "draft",
          },
          ship: {
            target: "publish",
          },
        },
      },
      shipped: {
        type: "final",
      },
    },
  },
} as const;

export const launchNoteAmendment = {
  initial: "write",
  states: {
    review: {
      meta: {
        step: {
          kind: "ask",
          message: "Review this note for Rat King accuracy",
          to: "rats-nest/desk",
          writes: "review",
        },
      },
      on: {
        replied: {
          target: "written",
        },
      },
    },
    write: {
      meta: {
        step: {
          agent: {
            model: "sol",
            thinking: "medium",
          },
          kind: "think",
          prompt: "Write the launch note",
          writes: "note",
        },
      },
      on: {
        done: {
          target: "review",
        },
      },
    },
    written: {
      type: "final",
    },
  },
} as const;
