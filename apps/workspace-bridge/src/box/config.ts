import { Config, Effect, Schema } from "effect";

import { refusal } from "../protocol.js";

export const DEFAULT_BROWSER_BUILD_ROOT = "/opt/burrow-cells";

export const DEFAULT_BROWSER_MAX_LIVE = 6;

export const BrowserMaxLive = Schema.Int.check(Schema.isGreaterThan(0));

const ImageReference = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][^\s]*@sha256:[0-9a-f]{64}$/u)
);

const ConfiguredImages = Schema.Struct({
  browser: Schema.optionalKey(ImageReference),
  full: Schema.optionalKey(ImageReference),
});

export const BoxImages = Schema.Struct({
  browser: Schema.optionalKey(ImageReference),
  full: ImageReference,
});

export const floatingImageRefusal = () =>
  refusal(
    "A floating box image could change tools after a wake. Set MISCHIEF_PEON_BOX_IMAGES (or legacy MISCHIEF_PEON_BOX_IMAGE for full) to immutable @sha256 digest references and restart."
  );

export const boxImagesFromConfig = Effect.gen(function* boxImagesFromConfig() {
  const map = yield* Config.String("MISCHIEF_PEON_BOX_IMAGES").pipe(
    Config.withDefault("")
  );

  const legacy = yield* Config.String("MISCHIEF_PEON_BOX_IMAGE").pipe(
    Config.withDefault("")
  );

  const images = yield* Schema.decodeEffect(
    Schema.fromJsonString(ConfiguredImages),
    { onExcessProperty: "error" }
  )(map === "" ? "{}" : map).pipe(Effect.mapError(floatingImageRefusal));

  return yield* Schema.decodeEffect(BoxImages)({
    ...images,
    full: images.full ?? legacy,
  }).pipe(Effect.mapError(floatingImageRefusal));
});

export const boxStorageFromConfig = Effect.gen(
  function* boxStorageFromConfig() {
    const paths = {
      MISCHIEF_BOX_MOUNT: yield* Config.String("MISCHIEF_BOX_MOUNT").pipe(
        Config.withDefault("")
      ),
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
      mount: paths.MISCHIEF_BOX_MOUNT,
      root: paths.MISCHIEF_BOX_ROOT,
      snapshots: paths.MISCHIEF_BOX_SNAPSHOTS,
    };
  }
);
