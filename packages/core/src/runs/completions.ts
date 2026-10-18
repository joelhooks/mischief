import { Effect, Option, Predicate, Schema } from "effect";
import type { Snapshot } from "xstate";

import { CompletionLost } from "./completion-lost.js";
import type { Journal } from "./run-store.js";
import type { QueuedEvent, StoredEvent } from "./schema.js";

export type JournalKeys = WeakMap<object, string>;

export const remember = (
  keys: JournalKeys,
  key: string,
  entry: Schema.Json
) => {
  if (Predicate.isObject(entry)) {
    keys.set(entry, key);
  }
};

export const storedEvent =
  (keys: JournalKeys) =>
  (event: QueuedEvent): StoredEvent => {
    const { output, ...rest } = event;
    const at = Predicate.isObject(output) ? keys.get(output) : undefined;

    return at === undefined
      ? structuredClone(event)
      : { ...structuredClone(rest), outputAt: at };
  };

export const liveEvent =
  (runId: string, journal: Journal, keys: JournalKeys) =>
  (event: StoredEvent): Effect.Effect<QueuedEvent> => {
    const { outputAt, ...rest } = event;

    if (outputAt === undefined) {
      return Effect.succeed(event);
    }

    const output = journal.get(outputAt);

    if (output === undefined) {
      return Effect.die(
        new CompletionLost({ key: outputAt, runId, type: event.type })
      );
    }

    remember(keys, outputAt, output);

    return Effect.succeed({ ...rest, output });
  };

const Rest = Schema.Record(Schema.String, Schema.Unknown);

const EffectSchema = Schema.StructWithRest(
  Schema.Struct({ status: Schema.String }),
  [Rest]
);

const DoneSchema = Schema.StructWithRest(
  Schema.Struct({
    effects: Schema.optionalKey(Schema.Record(Schema.String, EffectSchema)),
    status: Schema.Literal("done"),
  }),
  [Rest]
);

const ChildSchema = Schema.StructWithRest(
  Schema.Struct({ snapshot: Schema.optionalKey(Schema.Unknown) }),
  [Rest]
);

const ChildrenSchema = Schema.Struct({
  children: Schema.Record(Schema.String, ChildSchema),
});

const decodeDone = Schema.decodeUnknownOption(DoneSchema);

const decodeChildren = Schema.decodeUnknownOption(ChildrenSchema);

type Child = typeof ChildSchema.Type;

const settledEffect = ({
  output: _output,
  ...effect
}: typeof EffectSchema.Type) => effect;

const withoutOutput = (child: Child): Child =>
  Option.match(decodeDone(child.snapshot), {
    onNone: () => child,
    onSome: ({ effects, output: _output, ...done }) => ({
      ...child,
      snapshot:
        effects === undefined
          ? done
          : {
              ...done,
              effects: Object.fromEntries(
                Object.entries(effects).map(([key, effect]) => [
                  key,
                  settledEffect(effect),
                ])
              ),
            },
    }),
  });

export const withoutDoneOutputs = (
  persisted: Snapshot<unknown>
): Snapshot<unknown> =>
  Option.match(decodeChildren(persisted), {
    onNone: () => persisted,
    onSome: ({ children }) => {
      const compact = {
        children: Object.fromEntries(
          Object.entries(children).map(([id, child]) => [
            id,
            withoutOutput(child),
          ])
        ),
      };

      const stored: Snapshot<unknown> = { ...persisted, ...compact };

      return stored;
    },
  });
