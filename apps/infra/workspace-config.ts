import { Config, Effect, Option } from "effect";

export const workspaceFromConfig = Effect.gen(function* workspaceFromConfig() {
  const mode = yield* Config.Literals(["off", "on"], "MISCHIEF_WORKSPACE").pipe(
    Config.withDefault("off" as const)
  );

  const url = yield* Config.String("MISCHIEF_WORKSPACE_BRIDGE_URL").pipe(
    Config.withDefault("")
  );

  if (mode === "on" && url === "") {
    return yield* Effect.die(
      new Error(
        "MISCHIEF_WORKSPACE=on with an empty MISCHIEF_WORKSPACE_BRIDGE_URL routes workspace work to nowhere. Set MISCHIEF_WORKSPACE_BRIDGE_URL to the workspace bridge URL, or set MISCHIEF_WORKSPACE=off, then run infra:plan again"
      )
    );
  }

  if (url === "") {
    return Option.none();
  }

  return Option.some({
    bridgeEntry: yield* Config.String("MISCHIEF_WORKSPACE_BRIDGE_ENTRY"),
    mode,
    proxyEntry: yield* Config.String("MISCHIEF_PEON_PROXY_ENTRY"),
    repos: yield* Config.String("MISCHIEF_WORKSPACE_REPOS").pipe(
      Config.withDefault("")
    ),
    url,
  });
});
