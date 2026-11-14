import { Config, Effect } from "effect";

import { refusal } from "../protocol.js";

export const boxStorageFromConfig = Effect.gen(
  function* boxStorageFromConfig() {
    const paths = {
      MISCHIEF_BOX_METADATA: yield* Config.String("MISCHIEF_BOX_METADATA").pipe(
        Config.withDefault("")
      ),
      MISCHIEF_BOX_ROOT: yield* Config.String("MISCHIEF_BOX_ROOT").pipe(
        Config.withDefault("")
      ),
      MISCHIEF_BOX_SNAPSHOTS: yield* Config.String(
        "MISCHIEF_BOX_SNAPSHOTS"
      ).pipe(Config.withDefault("")),
    };

    const missing = Object.entries(paths)
      .filter(([, value]) => value.trim() === "")
      .map(([name]) => name);

    if (missing.length > 0) {
      return yield* refusal(
        `Missing required host paths: ${missing.join(", ")}. A default could make a box write into an unintended host directory. Set each named variable to an absolute host-owned directory, then restart the box manager.`
      );
    }

    return {
      metadata: paths.MISCHIEF_BOX_METADATA,
      root: paths.MISCHIEF_BOX_ROOT,
      snapshots: paths.MISCHIEF_BOX_SNAPSHOTS,
    };
  }
);
