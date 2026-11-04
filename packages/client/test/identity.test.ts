import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";

import { loadIdentity } from "../src/identity.js";
import { freshIdentity } from "./identity-fixture.js";

it.effect(
  "identity discovery leases the existing pi-ratking secret without putting the key in argv or diagnostics",
  () =>
    Effect.gen(function* secretBoundary() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      const identity = yield* freshIdentity();
      yield* fs.writeFileString(
        path.join(dir, "identity.json"),
        JSON.stringify(identity)
      );
      const executable = path.join(dir, "secrets.mjs");
      yield* fs.writeFileString(
        executable,
        '#!/usr/bin/env node\nimport { readFileSync, writeFileSync } from "node:fs";\nwriteFileSync(new URL("argv.json", import.meta.url), JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(readFileSync(new URL("identity.json", import.meta.url)));\n'
      );
      yield* fs.chmod(executable, 0o700);
      const loaded = yield* loadIdentity("example/desk", executable);
      expect(loaded).toEqual(identity);
      const argv = yield* fs.readFileString(path.join(dir, "argv.json"));
      expect(argv).not.toContain(identity.signing.d);
      expect(argv).not.toContain(identity.agreement.d);

      const argumentsList = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Array(Schema.String))
      )(argv);

      expect(argumentsList).toContain(
        "rat_king_fleet_agent_example.desk_identity"
      );
      expect(argumentsList).not.toContain(JSON.stringify(identity));

      const failure = yield* loadIdentity(
        JSON.stringify(identity),
        executable
      ).pipe(Effect.flip);

      expect(failure).toMatchObject({ kind: "configuration" });
      expect(JSON.stringify(failure)).not.toContain(identity.signing.d);
      expect(yield* fs.readFileString(path.join(dir, "argv.json"))).toBe(argv);
      yield* fs.writeFileString(
        path.join(dir, "identity.json"),
        `malformed ${identity.signing.d}`
      );

      const malformed = yield* loadIdentity("example/desk", executable).pipe(
        Effect.flip
      );

      expect(malformed).toMatchObject({ kind: "identity" });
      expect(JSON.stringify(malformed)).not.toContain(identity.signing.d);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
