import { Config, Effect } from "effect";

export const peonVars = Effect.gen(function* peonVars() {
  const mode = yield* Config.Literals(
    ["off", "on"],
    "MISCHIEF_PEON_BOXES"
  ).pipe(Config.withDefault("off"));

  if (mode === "off") {
    return { MISCHIEF_PEON_BOXES: mode };
  }

  const url = yield* Config.String("MISCHIEF_BOX_URL");
  const parsed = new URL(url);

  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    return yield* Effect.die(
      new Error(
        "MISCHIEF_BOX_URL must be an HTTP(S) origin without credentials, path, query or fragment; malformed routing could expose box credentials. Set the box manager origin and retry infra:plan."
      )
    );
  }

  return { MISCHIEF_BOX_URL: url, MISCHIEF_PEON_BOXES: mode };
});
