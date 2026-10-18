export const inlineOutputsRun = String.raw`{
  "docs": {
    "out_0": "answer to p0",
    "out_1": "answer to p1",
    "out_2": "answer to p2"
  },
  "fingerprints": [
    [
      "logic:wide/0.wide.fan.b0.think#1",
      "11bcf99666f12eab1629a2dac04027908cdfcb7420a02a85840deb6acb279d77"
    ],
    [
      "logic:wide/0.wide.fan.b1.think#1",
      "8bd9d0665858bf34272c5a3acecd2b6e7d19c767171aef98b34ce1bf2167c294"
    ],
    [
      "logic:wide/0.wide.fan.b2.think#1",
      "f515bb6f18491b330f36e0b2d40a21112cadc09c41bf4056dd41f1d1b13d1d69"
    ]
  ],
  "journal": [
    [
      "logic:wide/0.wide.fan.b0.think#1",
      {
        "cacheRead": 0,
        "output": "answer to p0",
        "tokens": 1
      }
    ],
    [
      "logic:wide/0.wide.fan.b1.think#1",
      {
        "cacheRead": 0,
        "output": "answer to p1",
        "tokens": 1
      }
    ],
    [
      "logic:wide/0.wide.fan.b2.think#1",
      {
        "cacheRead": 0,
        "output": "answer to p2",
        "tokens": 1
      }
    ]
  ],
  "plan": {
    "defaults": {
      "agent": {
        "model": "sol"
      }
    },
    "envelope": {
      "maxAgents": 3,
      "maxDepth": 3,
      "maxSteps": 13,
      "maxThinking": "low",
      "models": [
        "sol"
      ],
      "names": [],
      "thresholds": {
        "judge": 0.8
      }
    },
    "goal": "Think 3 times at once",
    "id": "wide",
    "machine": {
      "id": "wide",
      "initial": "fan",
      "states": {
        "done": {
          "type": "final"
        },
        "fan": {
          "meta": {
            "step": {
              "branches": {
                "b0": {
                  "initial": "think",
                  "states": {
                    "done": {
                      "type": "final"
                    },
                    "think": {
                      "meta": {
                        "step": {
                          "agent": {
                            "extensions": [],
                            "model": "sol",
                            "placement": "child",
                            "skills": [],
                            "tools": [
                              "plan-docs.read",
                              "plan-docs.write",
                              "report",
                              "ask-parent"
                            ]
                          },
                          "kind": "think",
                          "prompt": "p0",
                          "writes": "out_0"
                        }
                      },
                      "on": {
                        "done": {
                          "target": "done"
                        }
                      }
                    }
                  }
                },
                "b1": {
                  "initial": "think",
                  "states": {
                    "done": {
                      "type": "final"
                    },
                    "think": {
                      "meta": {
                        "step": {
                          "agent": {
                            "extensions": [],
                            "model": "sol",
                            "placement": "child",
                            "skills": [],
                            "tools": [
                              "plan-docs.read",
                              "plan-docs.write",
                              "report",
                              "ask-parent"
                            ]
                          },
                          "kind": "think",
                          "prompt": "p1",
                          "writes": "out_1"
                        }
                      },
                      "on": {
                        "done": {
                          "target": "done"
                        }
                      }
                    }
                  }
                },
                "b2": {
                  "initial": "think",
                  "states": {
                    "done": {
                      "type": "final"
                    },
                    "think": {
                      "meta": {
                        "step": {
                          "agent": {
                            "extensions": [],
                            "model": "sol",
                            "placement": "child",
                            "skills": [],
                            "tools": [
                              "plan-docs.read",
                              "plan-docs.write",
                              "report",
                              "ask-parent"
                            ]
                          },
                          "kind": "think",
                          "prompt": "p2",
                          "writes": "out_2"
                        }
                      },
                      "on": {
                        "done": {
                          "target": "done"
                        }
                      }
                    }
                  }
                }
              },
              "join": "allSettled",
              "kind": "parallel"
            }
          },
          "on": {
            "done": {
              "target": "done"
            }
          }
        }
      }
    },
    "version": 1
  },
  "state": {
    "answers": {},
    "asking": null,
    "awaiting": [],
    "capped": null,
    "checkpoint": {
      "mailbox": [
        {
          "actorId": "0.wide.fan.b0.think",
          "output": {
            "cacheRead": 0,
            "output": "answer to p0",
            "tokens": 1
          },
          "sessionId": "wide:wide:1",
          "type": "xstate.done.actor"
        },
        {
          "actorId": "0.wide.fan.b1.think",
          "output": {
            "cacheRead": 0,
            "output": "answer to p1",
            "tokens": 1
          },
          "sessionId": "wide:wide:2",
          "type": "xstate.done.actor"
        }
      ],
      "pending": [],
      "snapshot": {
        "_nextTimerId": 0,
        "children": {
          "0.wide.fan.b0.think": {
            "address": "wide/0.wide.fan.b0.think",
            "snapshot": {
              "effects": {
                "async": {
                  "output": {
                    "cacheRead": 0,
                    "output": "answer to p0",
                    "tokens": 1
                  },
                  "status": "done"
                }
              },
              "output": {
                "cacheRead": 0,
                "output": "answer to p0",
                "tokens": 1
              },
              "status": "done"
            },
            "src": "think",
            "syncSnapshot": false
          },
          "0.wide.fan.b1.think": {
            "address": "wide/0.wide.fan.b1.think",
            "snapshot": {
              "effects": {
                "async": {
                  "output": {
                    "cacheRead": 0,
                    "output": "answer to p1",
                    "tokens": 1
                  },
                  "status": "done"
                }
              },
              "output": {
                "cacheRead": 0,
                "output": "answer to p1",
                "tokens": 1
              },
              "status": "done"
            },
            "src": "think",
            "syncSnapshot": false
          }
        },
        "context": {},
        "historyValue": {},
        "machine": {
          "id": "wide",
          "version": "1"
        },
        "status": "active",
        "timers": {},
        "value": {
          "fan": {
            "b0": "think",
            "b1": "think",
            "b2": "done"
          }
        },
        "version": "1"
      },
      "starts": {
        "wide/0.wide.fan.b0.think": 1,
        "wide/0.wide.fan.b1.think": 1,
        "wide/0.wide.fan.b2.think": 1
      },
      "transitionIndex": 2
    },
    "held": [],
    "planVersion": 1,
    "replies": [],
    "revision": null,
    "seeded": [],
    "status": "running",
    "transitions": 2,
    "value": "fan.b0.think | fan.b1.think | fan.b2.done"
  }
}`;
