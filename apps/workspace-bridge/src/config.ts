import { Effect, Schema } from "effect";

import { refusal } from "./protocol.js";

const Repo = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u)
);

export const decodeMirrors = Effect.fn("WorkspaceBridge.decodeMirrors")(
  function* decodeMirrors(text: string, host: string) {
    const repos = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Record(Schema.String, Schema.String))
    )(text).pipe(
      Effect.mapError(() =>
        refusal(
          "MISCHIEF_WORKSPACE_MIRRORS is not a JSON object of owner/repo to read-only walgit URL. Configure that map and restart the bridge."
        )
      )
    );

    for (const [repo, remote] of Object.entries(repos)) {
      const invalid = () =>
        refusal(
          `Invalid MISCHIEF_WORKSPACE_MIRRORS entry for ${JSON.stringify(repo)}. Use owner/repo and an https URL on MISCHIEF_WORKSPACE_WALGIT_HOST, without credentials, a query or fragment; keep read-only credentials in host Git config.`
        );

      if (!Schema.is(Repo)(repo)) {
        return yield* invalid();
      }

      const url = yield* Effect.try({
        catch: invalid,
        try: () => new URL(remote),
      });

      if (
        url.protocol !== "https:" ||
        url.host !== host ||
        url.username !== "" ||
        url.password !== "" ||
        url.search !== "" ||
        url.hash !== ""
      ) {
        return yield* invalid();
      }
    }

    return repos;
  }
);
