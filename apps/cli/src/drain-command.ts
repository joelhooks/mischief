import { consumeDrained } from "@mischief/core";
import { Console, Effect, FileSystem, Path, Predicate, Stream } from "effect";
import { Command } from "effect/cli";
import { Stdio } from "effect/Stdio";

import { runsRoot } from "./run-layer.js";

const keepUnrouted = Effect.fn("keepUnrouted")(function* keep(line: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* runsRoot;

  yield* fs.makeDirectory(root, { recursive: true });
  yield* fs.writeFileString(path.join(root, "__unrouted.jsonl"), `${line}\n`, {
    flag: "a",
  });
});

const consumeLine = Effect.fn("consumeLine")(function* consume(raw: string) {
  const outcome = yield* consumeDrained(raw);

  if (Predicate.isTagged(outcome, "Unrouted")) {
    yield* keepUnrouted(raw);
  }

  yield* Console.log(JSON.stringify(outcome));
});

export const drainCommand = Command.make("drain", {}, () =>
  Effect.gen(function* drain() {
    const stdio = yield* Stdio;

    yield* stdio.stdin.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line.trim().length > 0),
      Stream.runForEach(consumeLine)
    );
  }).pipe(Effect.orDie)
).pipe(
  Command.withDescription(
    "Consume a nest drain batch on stdin, one mailbox line per row: deliver each reply to its run, keep plain messages in __unrouted.jsonl, and exit 0 only when every line was handled. Use as: nest drain --as <name> --exec 'mischief drain'"
  )
);
