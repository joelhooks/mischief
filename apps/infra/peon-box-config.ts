import { Config, Effect, Option } from "effect";

export const peonBoxesFromConfig = Effect.gen(function* peonBoxesFromConfig() {
  const enabled = yield* Config.Literals(
    ["off", "on"],
    "MISCHIEF_PEON_BOXES"
  ).pipe(Config.withDefault("off"));

  if (enabled !== "on") {
    return Option.none();
  }

  const mount = yield* Config.String("MISCHIEF_BOX_MOUNT").pipe(
    Config.withDefault("")
  );

  if (
    !/^\/(?:[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/)*[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/u.test(
      mount
    )
  ) {
    return yield* Effect.die(
      "MISCHIEF_BOX_MOUNT must name an absolute canonical dedicated volume path (letters, digits, dots, underscores and hyphens; no trailing slash). Without a mount gate boxes could write to the shared root disk when the volume is absent and stop other services. Set MISCHIEF_BOX_MOUNT, then run infra:plan again."
    );
  }

  const boxEntry = yield* Config.String("MISCHIEF_BOX_ENTRY");
  const proxyEntry = yield* Config.String("MISCHIEF_PEON_FULL_PROXY_ENTRY");

  if (!boxEntry.startsWith("/") || !proxyEntry.startsWith("/")) {
    return yield* Effect.die(
      "Peon box units need absolute built entry paths; relative paths could start the wrong code. Set MISCHIEF_BOX_ENTRY and MISCHIEF_PEON_FULL_PROXY_ENTRY, then run infra:plan again."
    );
  }

  const archive = yield* Config.all({
    MISCHIEF_BOX_ARCHIVE_PRIMARY: Config.String(
      "MISCHIEF_BOX_ARCHIVE_PRIMARY"
    ).pipe(Config.withDefault("")),
    MISCHIEF_BOX_ARCHIVE_REPLICA: Config.String(
      "MISCHIEF_BOX_ARCHIVE_REPLICA"
    ).pipe(Config.withDefault("")),
    MISCHIEF_BOX_ARCHIVE_HOST: Config.String("MISCHIEF_BOX_ARCHIVE_HOST").pipe(
      Config.withDefault("")
    ),
  });

  if (
    Object.values(archive).some((value) => !/^[A-Za-z0-9_./-]*$/u.test(value))
  ) {
    return yield* Effect.die(
      "Box archive config contains characters unsafe in a systemd unit. Supply plain mount paths and a short checker hostname before retrying infra:plan."
    );
  }

  return Option.some({ archive, boxEntry, mount, proxyEntry });
});
