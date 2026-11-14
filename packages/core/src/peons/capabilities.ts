import { implement } from "@mischief/capability/implement";
import { Context } from "effect";
import type { Effect } from "effect";

import {
  clonePeonContract,
  destroyPeonContract,
  hibernatePeonContract,
  inspectPeonContract,
  listPeonsContract,
  listPeonTemplatesContract,
  promptPeonContract,
  resumePeonContract,
  savePeonTemplateContract,
  spawnPeonContract,
  suspendPeonContract,
} from "./contracts.js";
import type { PeonRefused } from "./schema.js";

type Operation<
  C extends {
    readonly input: { readonly Type: object };
    readonly output: { readonly Type: object };
  },
> = (
  input: C["input"]["Type"]
) => Effect.Effect<C["output"]["Type"], PeonRefused>;

export class Peons extends Context.Service<
  Peons,
  {
    readonly spawnPeon: Operation<typeof spawnPeonContract>;
    readonly promptPeon: Operation<typeof promptPeonContract>;
    readonly suspendPeon: Operation<typeof suspendPeonContract>;
    readonly resumePeon: Operation<typeof resumePeonContract>;
    readonly hibernatePeon: Operation<typeof hibernatePeonContract>;
    readonly clonePeon: Operation<typeof clonePeonContract>;
    readonly destroyPeon: Operation<typeof destroyPeonContract>;
    readonly inspectPeon: Operation<typeof inspectPeonContract>;
    readonly listPeonTemplates: Operation<typeof listPeonTemplatesContract>;
    readonly savePeonTemplate: Operation<typeof savePeonTemplateContract>;
    readonly listPeons: Operation<typeof listPeonsContract>;
  }
>()("@mischief/core/Peons") {}

export const spawnPeon = implement(spawnPeonContract, (input) =>
  Peons.use((peons) => peons.spawnPeon(input))
);

export const promptPeon = implement(promptPeonContract, (input) =>
  Peons.use((peons) => peons.promptPeon(input))
);

export const suspendPeon = implement(suspendPeonContract, (input) =>
  Peons.use((peons) => peons.suspendPeon(input))
);

export const resumePeon = implement(resumePeonContract, (input) =>
  Peons.use((peons) => peons.resumePeon(input))
);

export const hibernatePeon = implement(hibernatePeonContract, (input) =>
  Peons.use((peons) => peons.hibernatePeon(input))
);

export const clonePeon = implement(clonePeonContract, (input) =>
  Peons.use((peons) => peons.clonePeon(input))
);

export const destroyPeon = implement(destroyPeonContract, (input) =>
  Peons.use((peons) => peons.destroyPeon(input))
);

export const inspectPeon = implement(inspectPeonContract, (input) =>
  Peons.use((peons) => peons.inspectPeon(input))
);

export const listPeonTemplates = implement(listPeonTemplatesContract, (input) =>
  Peons.use((peons) => peons.listPeonTemplates(input))
);

export const savePeonTemplate = implement(savePeonTemplateContract, (input) =>
  Peons.use((peons) => peons.savePeonTemplate(input))
);

export const listPeons = implement(listPeonsContract, (input) =>
  Peons.use((peons) => peons.listPeons(input))
);

export const peonCapabilities = [
  spawnPeon,
  promptPeon,
  suspendPeon,
  resumePeon,
  hibernatePeon,
  clonePeon,
  destroyPeon,
  inspectPeon,
  listPeonTemplates,
  savePeonTemplate,
  listPeons,
] as const;
