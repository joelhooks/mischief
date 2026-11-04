import { Config, Effect, FileSystem, Option, Path, Schema } from "effect";

import { ClientError } from "./client-error.js";
import { Client, Host } from "./client.js";
import { loadIdentity } from "./identity.js";

export const ProjectConfig = Schema.Struct({
  caller: Schema.optionalKey(Schema.String),
  hosts: Schema.Record(Schema.String, Host),
});

export const projectClient = Effect.fn("MischiefClient.project")(
  function* projectClient(cwd: string, host: string) {
    const caller = Option.getOrUndefined(
      yield* Config.option(Config.String("RATKING_NAME")).pipe(
        Effect.mapError(
          () =>
            new ClientError({
              kind: "configuration",
              operation: "identity",
              reason:
                "Could not read this Pi's RATKING_NAME. Start the session with its own canonical Rat King name, then retry mischief; no identity was leased.",
            })
        )
      )
    );

    if (caller === undefined || caller === "" || caller === "off") {
      return yield* new ClientError({
        kind: "configuration",
        operation: "identity",
        reason:
          "This Pi has no active RATKING_NAME. A Pi calls Mischief only as itself. Start this session with its own Rat King name, then retry mischief; a repo file cannot choose a signing identity.",
      });
    }

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configPath = path.join(cwd, ".pi", "mischief.json");

    const config = yield* fs.readFileString(configPath).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectConfig), {
          onExcessProperty: "error",
        })
      ),
      Effect.mapError(
        () =>
          new ClientError({
            kind: "configuration",
            operation: "configure",
            reason:
              "Missing or invalid .pi/mischief.json. Opt in with named hosts (endpoint and audience); caller is optional and may only assert this Pi's RATKING_NAME. See docs/first-plan.md, then retry mischief.",
          })
      )
    );

    if (config.caller !== undefined && config.caller !== caller) {
      return yield* new ClientError({
        kind: "configuration",
        operation: "identity",
        reason: `This Pi is ${JSON.stringify(caller)}; .pi/mischief.json names ${JSON.stringify(config.caller)}. A Pi calls Mischief only as itself. Remove caller from .pi/mischief.json or set it to this Pi's own name, then retry mischief; no identity was leased.`,
      });
    }

    const target = config.hosts[host];

    if (target === undefined) {
      return yield* new ClientError({
        kind: "configuration",
        operation: "configure",
        reason: `Unknown Mischief host ${JSON.stringify(host)}. Accepted host names: ${Object.keys(config.hosts).join(", ") || "none"}. Add the host to .pi/mischief.json, then retry mischief.`,
      });
    }

    const identity = yield* loadIdentity(caller);

    return yield* Client.pipe(Effect.provide(Client.layer(target, identity)));
  }
);
