import type { listPeonsContract, PeonIndexEntry } from "@mischief/core";
import { PeonState } from "@mischief/core";
import { Schema } from "effect";

const StateList = Schema.Array(PeonState);

export const listedPeonStates = (
  state: (typeof listPeonsContract.input.Type)["state"]
): readonly (typeof PeonState.Type)[] | null => {
  if (state === undefined) {
    return ["running", "idle"];
  }

  if (state === "all") {
    return null;
  }

  return Schema.is(StateList)(state) ? state : [state];
};

export const peonMatches = (
  entry: typeof PeonIndexEntry.Type,
  filter: typeof listPeonsContract.input.Type,
  owner: string
) => {
  if (
    entry.owner !== owner ||
    (filter.owner !== undefined && filter.owner !== entry.owner) ||
    (filter.template !== undefined && filter.template !== entry.template.name)
  ) {
    return false;
  }

  if (filter.state === undefined) {
    return entry.state === "running" || entry.state === "idle";
  }

  if (Schema.is(StateList)(filter.state)) {
    return filter.state.includes(entry.state);
  }

  return filter.state === "all" || entry.state === filter.state;
};
