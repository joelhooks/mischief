import { Thinker } from "@mischief/core";
import { Effect } from "effect";

import { piThinker } from "../dist/index.js";
import { fauxWorld } from "./faux-world.ts";

const [dir, runId, key, visit, prompt, epoch, mode] = process.argv.slice(2);

const hang = mode === "hang";

const options = fauxWorld(dir, hang, () => {
  if (hang) {
    process.stdout.write("CALLED\n");
  }
});

const program = Effect.gen(function* child() {
  const thinker = yield* Thinker;

  const thought = yield* thinker.think({
    agent: { model: "sol", thinking: "low" },
    epoch: Number(epoch),
    key,
    prompt,
    runId,
    visit: Number(visit),
  });

  process.stdout.write(`ANSWERED ${JSON.stringify(thought)}\n`);

  return yield* Effect.never;
}).pipe(Effect.provide(piThinker(options)));

try {
  await Effect.runPromise(program);
} catch (error) {
  process.stdout.write(`FAILED ${String(error)}\n`);
  process.exitCode = 1;
}
