import { machineFromJSON } from "xstate";
import type { InvokeJSON, StateNodeJSON } from "xstate";

import type { CompiledMachine } from "./compile.js";

const hydrateNode = (
  node: StateNodeJSON,
  path: readonly string[],
  machineId: string
): StateNodeJSON => {
  const hydrated: StateNodeJSON = { ...node };

  const invoke = (definition: InvokeJSON, index: number): InvokeJSON => ({
    ...definition,
    id: definition.id ?? `${index}.${[machineId, ...path].join(".")}`,
  });

  if (node.invoke !== undefined) {
    hydrated.invoke = Array.isArray(node.invoke)
      ? node.invoke.map(invoke)
      : invoke(node.invoke, 0);
  }

  if (node.on !== undefined) {
    const on: NonNullable<StateNodeJSON["on"]> = {};

    for (const [event, transition] of Object.entries(node.on)) {
      const prefix = "xstate.done.state.";

      const legacy = event.startsWith(prefix);
      const eventType = legacy ? "xstate.done.state" : event;
      const entries = Array.isArray(transition) ? transition : [transition];
      const matches = { stateId: event.slice(prefix.length) };

      const mapped = legacy
        ? entries.map((entry) => ({ ...entry, matches }))
        : entries;

      const existing = on[eventType];

      on[eventType] =
        existing === undefined
          ? mapped
          : [...(Array.isArray(existing) ? existing : [existing]), ...mapped];
    }

    hydrated.on = on;
  }

  if (node.states !== undefined) {
    hydrated.states = Object.fromEntries(
      Object.entries(node.states).map(([key, child]) => [
        key,
        hydrateNode(child, [...path, key], machineId),
      ])
    );
  }

  return hydrated;
};

export type PlanSources = Parameters<typeof machineFromJSON>[1];

export const hydratePlan = (compiled: CompiledMachine, sources: PlanSources) =>
  machineFromJSON(
    { ...compiled, ...hydrateNode(compiled, [], compiled.id) },
    sources
  );
