import { Config, Effect, Option } from "effect";

export const peonBoxesFromConfig = Effect.gen(function* peonBoxesFromConfig() {
  const enabled = yield* Config.Literals(
    ["off", "on"],
    "MISCHIEF_PEON_BOXES"
  ).pipe(Config.withDefault("off"));

  if (enabled !== "on") {
    return Option.none();
  }

  const boxEntry = yield* Config.String("MISCHIEF_BOX_ENTRY");
  const proxyEntry = yield* Config.String("MISCHIEF_PEON_FULL_PROXY_ENTRY");

  if (!boxEntry.startsWith("/") || !proxyEntry.startsWith("/")) {
    return yield* Effect.die(
      "Peon box units need absolute built entry paths; relative paths could start the wrong code. Set MISCHIEF_BOX_ENTRY and MISCHIEF_PEON_FULL_PROXY_ENTRY, then run infra:plan again."
    );
  }

  return Option.some({ boxEntry, proxyEntry });
});
