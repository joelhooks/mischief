import type { Callable } from "@mischief/core";
import { CapabilityName } from "@mischief/core";
import { Schema } from "effect";

const validName = Schema.is(CapabilityName);

export const registeredCallables = (
  entries: Iterable<readonly [string, Callable]>
): ReadonlyMap<string, Callable> => {
  const registry = new Map<string, Callable>();

  for (const [name, capability] of entries) {
    if (!validName(name)) {
      throw new Error(
        `Cannot register call capability ${JSON.stringify(name)}: names must match ^[a-z][a-z0-9-]{0,63}$. Rename it before calling planRunWorker({ callables })`
      );
    }

    if (registry.has(name)) {
      throw new Error(
        `Cannot register duplicate call capability ${JSON.stringify(name)}. Pass each name once to planRunWorker({ callables }); a Map has already discarded duplicate keys`
      );
    }

    registry.set(name, capability);
  }

  return registry;
};
