import { Effect, FileSystem, Path, Schema } from "effect";

import { refusal } from "../protocol.js";

const ProxyModels = Schema.fromJsonString(
  Schema.StructWithRest(
    Schema.Struct({
      providers: Schema.StructWithRest(
        Schema.Struct({
          peon: Schema.StructWithRest(
            Schema.Struct({ baseUrl: Schema.String }),
            [Schema.JsonObject]
          ),
        }),
        [Schema.JsonObject]
      ),
    }),
    [Schema.JsonObject]
  )
);

const ClaudeBridge = Schema.fromJsonString(
  Schema.StructWithRest(
    Schema.Struct({
      provider: Schema.StructWithRest(
        Schema.Struct({
          env: Schema.StructWithRest(
            Schema.Struct({ ANTHROPIC_BASE_URL: Schema.String }),
            [Schema.JsonObject]
          ),
        }),
        [Schema.JsonObject]
      ),
    }),
    [Schema.JsonObject]
  )
);

const repair = (file: string) =>
  refusal(
    `BoxProviderRefused: Could not safely set the browser model proxy in ${file}. Restore the regular manager-provisioned provider file and retry with a fresh requestId.`,
    503
  );

export const rewriteBrowserProviders = Effect.fnUntraced(
  function* rewriteBrowserProviders(root: string, baseUrl: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const agent = path.join(root, "home/.pi/agent");

    for (const directory of [
      root,
      path.join(root, "home"),
      path.join(root, "home/.pi"),
      agent,
    ]) {
      const info = yield* fs
        .lstat(directory)
        .pipe(Effect.mapError(() => repair("the Pi agent directory")));

      if (info.type !== "Directory") {
        return yield* repair("the Pi agent directory");
      }
    }

    const read = Effect.fnUntraced(function* read(file: string) {
      const target = path.join(agent, file);

      const info = yield* fs
        .lstat(target)
        .pipe(Effect.mapError(() => repair(file)));

      if (info.type !== "File") {
        return yield* repair(file);
      }

      return yield* fs
        .readFileString(target)
        .pipe(Effect.mapError(() => repair(file)));
    });

    const models = yield* read("models.json").pipe(
      Effect.flatMap(Schema.decodeEffect(ProxyModels)),
      Effect.mapError(() => repair("models.json"))
    );

    const claude = yield* read("claude-bridge.json").pipe(
      Effect.flatMap(Schema.decodeEffect(ClaudeBridge)),
      Effect.mapError(() => repair("claude-bridge.json"))
    );

    const responsesUrl = `${baseUrl}/v1`;
    const writes = [];

    if (models.providers.peon.baseUrl !== responsesUrl) {
      writes.push({
        file: "models.json",
        value: {
          ...models,
          providers: {
            ...models.providers,
            peon: { ...models.providers.peon, baseUrl: responsesUrl },
          },
        },
      });
    }

    if (claude.provider.env.ANTHROPIC_BASE_URL !== baseUrl) {
      writes.push({
        file: "claude-bridge.json",
        value: {
          ...claude,
          provider: {
            ...claude.provider,
            env: { ...claude.provider.env, ANTHROPIC_BASE_URL: baseUrl },
          },
        },
      });
    }

    for (const { file, value } of writes) {
      yield* Effect.gen(function* replaceProviderFile() {
        const scratch = yield* fs.makeTempDirectoryScoped({ directory: agent });
        const temp = path.join(scratch, file);

        yield* fs.writeFileString(temp, `${JSON.stringify(value, null, 2)}\n`, {
          mode: 0o660,
        });
        yield* fs.rename(temp, path.join(agent, file));
      }).pipe(
        Effect.scoped,
        Effect.mapError(() => repair(file))
      );
    }

    return writes.length > 0;
  }
);
