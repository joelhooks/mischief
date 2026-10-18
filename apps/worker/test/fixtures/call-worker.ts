// @effect-diagnostics asyncFunction:off -- the fixture wraps the Worker fetch Promise API.
import { callable, planRunWorker } from "@mischief/worker";
import type { Callable, StepCall } from "@mischief/worker";
import { Effect, Schema } from "effect";

const calls: StepCall[] = [];

const countRefs = callable({
  input: Schema.Struct({ refs: Schema.Array(Schema.String) }),
  output: Schema.Struct({ count: Schema.Int }),
  run: ({ refs }, call) =>
    Effect.sync(() => {
      calls.push(call);

      return { count: refs.length };
    }),
});

const registrationError = (
  callables: Iterable<readonly [string, Callable]>
) => {
  try {
    planRunWorker({ callables });

    return null;
  } catch (error) {
    return String(error);
  }
};

const construction = {
  duplicate: registrationError([
    ["count-refs", countRefs],
    ["count-refs", countRefs],
  ]),
  invalid: registrationError([["not_a_capability", countRefs]]),
};

const worker = planRunWorker({ callables: [["count-refs", countRefs]] });

export const { PlanRun, Postbox, Schedule, ServiceTokenLedger } = worker;

export default {
  async fetch(...args: Parameters<typeof worker.default.fetch>) {
    const { pathname } = new URL(args[0].url);

    if (pathname === "/__calls") {
      return Response.json(calls);
    }

    if (pathname === "/__registration") {
      return Response.json(construction);
    }

    return await worker.default.fetch(...args);
  },
};
