import { Effect, Option, Predicate, Schema } from "effect";
import { createMachineFromConfig } from "xstate";
import type { AnyEventObject, Snapshot } from "xstate";
import { createDurable } from "xstate/durable";
import type { DurableExecution, DurableExecutionAdapter } from "xstate/durable";

import type { CompiledMachine } from "../plans/compile.js";
import type { QueuedEvent } from "./schema.js";

export type StateValue = string | StateValueMap;

export interface StateValueMap {
  readonly [region: string]: StateValue;
}

const StateValueSchema: Schema.Codec<StateValue> = Schema.Union([
  Schema.String,
  Schema.Record(
    Schema.String,
    Schema.suspend((): Schema.Codec<StateValue> => StateValueSchema)
  ),
]);

const ViewSchema = Schema.Struct({
  children: Schema.Record(
    Schema.String,
    Schema.UndefinedOr(Schema.Struct({ sessionId: Schema.String }))
  ),
  status: Schema.String,
  value: StateValueSchema,
});

export type ExecutionView = typeof ViewSchema.Type;

const decodeView = Schema.decodeUnknownSync(ViewSchema);

const StartSchema = Schema.Struct({
  descriptor: Schema.Struct({
    actor: Schema.String,
    type: Schema.Literal("@xstate.start"),
  }),
});

const decodeStart = Schema.decodeUnknownOption(StartSchema);

export type Sources = Parameters<typeof createMachineFromConfig>[1];

export type Adapter = Omit<
  DurableExecutionAdapter<ReturnType<typeof createMachineFromConfig>>,
  "transitionIndex"
>;

type Step = ReturnType<
  DurableExecution<ReturnType<typeof createMachineFromConfig>>["transition"]
>;

const typed = (step: Step) => {
  // SAFETY: AnyStateMachine types its snapshot as any; every read goes through decodeView or getPersistedSnapshot.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const snapshot = step[0] as Snapshot<unknown>;

  return { effects: step[1], snapshot };
};

export const leaves = (
  value: StateValue,
  prefix: readonly string[] = []
): (readonly string[])[] =>
  Predicate.isString(value)
    ? [[...prefix, value]]
    : Object.entries(value).flatMap(([key, child]) =>
        leaves(child, [...prefix, key])
      );

export const describeValue = (value: StateValue) =>
  leaves(value)
    .map((path) => path.join("."))
    .toSorted()
    .join(" | ");

export interface Opening {
  readonly persisted: Option.Option<Snapshot<unknown>>;
  readonly transitionIndex: number;
}

export const openExecution = (
  compiled: CompiledMachine,
  sources: Sources,
  adapter: Adapter,
  opening: Opening
) => {
  const machine = createMachineFromConfig(compiled, sources);

  const durable = createDurable(machine, {
    ...adapter,
    transitionIndex: opening.transitionIndex,
  });

  const cursor = typed(
    Option.match(opening.persisted, {
      onNone: () => durable.initialTransition(),
      onSome: (persisted) => durable.restore(persisted),
    })
  );

  const startsOf = () =>
    cursor.effects.flatMap((effect) =>
      Option.match(decodeStart(effect), {
        onNone: () => [],
        onSome: ({ descriptor }) => [descriptor.actor],
      })
    );

  return {
    flush: () => {
      const batch = cursor.effects;

      // oxlint-disable-next-line typescript/promise-function-async -- Effect.promise consumes a Promise factory directly.
      return Effect.promise(() => durable.executeEffects(batch));
    },
    next: Effect.promise(
      // oxlint-disable-next-line typescript/promise-function-async -- Effect.promise consumes a Promise factory directly.
      (): Promise<AnyEventObject> => durable.waitForEvent()
    ),
    nextTransitionIndex: () => durable.nextTransitionIndex,
    persist: (): Snapshot<unknown> =>
      machine.getPersistedSnapshot(cursor.snapshot),
    send: (event: QueuedEvent) => {
      Object.assign(cursor, typed(durable.transition(cursor.snapshot, event)));

      return startsOf();
    },
    started: Option.isNone(opening.persisted) ? startsOf() : [],
    view: (): ExecutionView => decodeView(cursor.snapshot),
  };
};

export type Execution = ReturnType<typeof openExecution>;
