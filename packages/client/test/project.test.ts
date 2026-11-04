import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Path,
  Predicate,
  Ref,
  Schema,
} from "effect";
import { FetchHttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { projectClient } from "../src/project.js";
import { freshIdentity } from "./identity-fixture.js";

const fixture = Effect.gen(function* projectFixture() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fs.makeTempDirectoryScoped();
  const identity = yield* freshIdentity();
  const executable = path.join(cwd, "secrets.mjs");
  const argvFile = path.join(cwd, "argv.json");

  yield* fs.makeDirectory(path.join(cwd, ".pi"));
  yield* fs.writeFileString(
    path.join(cwd, "identity.json"),
    JSON.stringify(identity)
  );
  yield* fs.writeFileString(
    executable,
    '#!/usr/bin/env node\nimport { readFileSync, writeFileSync } from "node:fs";\nwriteFileSync(new URL("argv.json", import.meta.url), JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(readFileSync(new URL("identity.json", import.meta.url)));\n'
  );
  yield* fs.chmod(executable, 0o700);

  const original = yield* ChildProcessSpawner.ChildProcessSpawner;
  const invocations = yield* Ref.make<readonly string[]>([]);

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* captureInvocation() {
      if (!Predicate.isTagged(command, "StandardCommand")) {
        return yield* Effect.die(
          "The identity lease must use one command, never a pipeline"
        );
      }

      yield* Ref.update(invocations, (commands) => [
        ...commands,
        command.command,
      ]);

      return yield* original.spawn(
        ChildProcess.make(executable, command.args, command.options)
      );
    })
  );

  const configure = (caller?: string, secretsCommand?: string) =>
    fs.writeFileString(
      path.join(cwd, ".pi", "mischief.json"),
      JSON.stringify({
        caller,
        hosts: {
          mischief: {
            audience: "did:web:host.example.invalid#mischief",
            endpoint: "https://mischief.example.invalid",
          },
        },
        secretsCommand,
      })
    );

  return { argvFile, configure, cwd, executable, fs, invocations, spawner };
});

const services = Layer.merge(NodeServices.layer, FetchHttpClient.layer);

it.effect(
  "repo policy cannot impersonate a desk or lease its identity from a worker session",
  () =>
    Effect.gen(function* refuseImpersonation() {
      const world = yield* fixture;

      yield* world.configure("project/desk");

      const failure = yield* projectClient(world.cwd, "mischief").pipe(
        Effect.flip,
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          world.spawner
        ),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ RATKING_NAME: "project/worker" })
        )
      );

      expect(failure).toMatchObject({ kind: "configuration" });
      expect(failure.reason).toContain("project/desk");
      expect(failure.reason).toContain("project/worker");
      expect(failure.reason).toContain("retry mischief");
      expect(yield* world.fs.exists(world.argvFile)).toBe(false);
      expect(yield* Ref.get(world.invocations)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(services))
);

it.effect(
  "RATKING_NAME alone chooses the existing worker identity; a repo file does not choose it",
  () =>
    Effect.gen(function* ownIdentity() {
      const world = yield* fixture;

      yield* world.configure();
      yield* projectClient(world.cwd, "mischief").pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          world.spawner
        ),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ RATKING_NAME: "project/worker" })
        )
      );

      const argv = yield* world.fs
        .readFileString(world.argvFile)
        .pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.fromJsonString(Schema.Array(Schema.String))
            )
          )
        );

      expect(yield* Ref.get(world.invocations)).toEqual(["secrets"]);
      expect(argv).toContain("rat_king_fleet_agent_project.worker_identity");
      expect(argv).not.toContain("rat_king_fleet_agent_project.desk_identity");
    }).pipe(Effect.scoped, Effect.provide(services))
);

it.effect(
  "a missing, empty or off session name refuses even when repo policy names a caller",
  () =>
    Effect.gen(function* noSessionIdentity() {
      const world = yield* fixture;

      yield* world.configure("project/desk");

      for (const name of [undefined, "", "off"]) {
        const failure = yield* projectClient(world.cwd, "mischief").pipe(
          Effect.flip,
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            world.spawner
          ),
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown(
              name === undefined ? {} : { RATKING_NAME: name }
            )
          )
        );

        expect(failure).toMatchObject({ kind: "configuration" });
        expect(failure.reason).toContain("RATKING_NAME");
        expect(yield* world.fs.exists(world.argvFile)).toBe(false);
        expect(yield* Ref.get(world.invocations)).toEqual([]);
      }
    }).pipe(Effect.scoped, Effect.provide(services))
);

it.effect(
  "repo policy cannot replace the program that supplies the signing key",
  () =>
    Effect.gen(function* noRepoExecutable() {
      const world = yield* fixture;

      yield* world.configure("project/worker", world.executable);

      const failure = yield* projectClient(world.cwd, "mischief").pipe(
        Effect.flip,
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          world.spawner
        ),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ RATKING_NAME: "project/worker" })
        )
      );

      expect(failure).toMatchObject({ kind: "configuration" });
      expect(failure.reason).toContain(".pi/mischief.json");
      expect(yield* Ref.get(world.invocations)).toEqual([]);
      expect(yield* world.fs.exists(world.argvFile)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(services))
);
