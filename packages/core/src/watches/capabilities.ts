import { defineContract } from "@mischief/capability/contract";
import { implement } from "@mischief/capability/implement";
import { Context, Schema } from "effect";
import type { Effect } from "effect";

import {
  WatchDefinition,
  WatchId,
  WatchInspection,
  WatchName,
  WatchOwner,
  WatchRefused,
  WatchState,
  WatchSummary,
} from "./schema.js";

const requestId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512)
);

export const armWatchContract = defineContract("armWatch", {
  annotations: { idempotent: true, openWorld: true },
  description:
    "Arm a durable condition check using the caller's armWatch grant.",
  input: Schema.Struct({ ...WatchDefinition.fields, requestId }),
  output: Schema.Struct({ watchId: WatchId, state: Schema.Literal("armed") }),
  failure: WatchRefused,
});

export const listWatchesContract = defineContract("listWatches", {
  annotations: { readOnly: true },
  description:
    "List watches, optionally filtered by owner DID or recipient name.",
  input: Schema.Struct({
    owner: Schema.optionalKey(WatchOwner),
    target: Schema.optionalKey(WatchName),
  }),
  output: Schema.Struct({ watches: Schema.Array(WatchSummary) }),
  failure: WatchRefused,
});

export const inspectWatchContract = defineContract("inspectWatch", {
  annotations: { readOnly: true },
  description:
    "Inspect a watch's definition, check, cursor, and recent receipts as its owner or Switchboard.",
  input: Schema.Struct({ watchId: WatchId }),
  output: WatchInspection,
  failure: WatchRefused,
});

const terminal = {
  annotations: { idempotent: true },
  input: Schema.Struct({ watchId: WatchId, requestId }),
  output: Schema.Struct({ state: WatchState }),
  failure: WatchRefused,
};

export const cancelWatchContract = defineContract("cancelWatch", {
  ...terminal,
  description: "Cancel a watch as its owner or Switchboard.",
});

export const completeWatchContract = defineContract("completeWatch", {
  ...terminal,
  description: "Mark a watch done as its owner or Switchboard.",
});

type Operation<
  C extends {
    readonly input: { readonly Type: object };
    readonly output: { readonly Type: object };
  },
> = (
  input: C["input"]["Type"]
) => Effect.Effect<C["output"]["Type"], WatchRefused>;

export class Watches extends Context.Service<
  Watches,
  {
    readonly armWatch: Operation<typeof armWatchContract>;
    readonly listWatches: Operation<typeof listWatchesContract>;
    readonly inspectWatch: Operation<typeof inspectWatchContract>;
    readonly cancelWatch: Operation<typeof cancelWatchContract>;
    readonly completeWatch: Operation<typeof completeWatchContract>;
  }
>()("@mischief/core/Watches") {}

export const watchCapabilities = [
  implement(armWatchContract, (input) =>
    Watches.use((watches) => watches.armWatch(input))
  ),
  implement(listWatchesContract, (input) =>
    Watches.use((watches) => watches.listWatches(input))
  ),
  implement(inspectWatchContract, (input) =>
    Watches.use((watches) => watches.inspectWatch(input))
  ),
  implement(cancelWatchContract, (input) =>
    Watches.use((watches) => watches.cancelWatch(input))
  ),
  implement(completeWatchContract, (input) =>
    Watches.use((watches) => watches.completeWatch(input))
  ),
] as const;

export const watchCapabilityNames: ReadonlySet<string> = new Set(
  watchCapabilities.map(({ contract }) => contract.name)
);
