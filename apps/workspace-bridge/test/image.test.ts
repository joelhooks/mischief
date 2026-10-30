import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Schema } from "effect";

import { Runner } from "../src/runner.js";
import { dockerArguments } from "../src/sandbox.js";
import { image, name, sha } from "./fixtures.js";

const Probe = Schema.Struct({
  agent: Schema.String,
  bakedModelsMode: Schema.Int,
  bakedSettingsMode: Schema.Int,
  canary: Schema.Null,
  home: Schema.String,
  modelsMode: Schema.Int,
  modelsText: Schema.String,
  settingsMode: Schema.Int,
  settingsText: Schema.String,
});

const probe = [
  'const fs = require("node:fs");',
  "const agent = process.env.PI_CODING_AGENT_DIR;",
  'const models = agent + "/models.json";',
  'const settings = agent + "/settings.json";',
  'const modelsText = fs.readFileSync(models, "utf8");',
  'const settingsText = fs.readFileSync(settings, "utf8");',
  "fs.writeFileSync(models, modelsText);",
  "fs.writeFileSync(settings, settingsText);",
  'console.log(JSON.stringify({ agent, home: process.env.HOME, canary: process.env.ANTHROPIC_API_KEY ?? null, modelsMode: fs.statSync(models).mode & 0o777, settingsMode: fs.statSync(settings).mode & 0o777, modelsText, settingsText, bakedModelsMode: fs.statSync(process.argv[1] + "/models.json").mode & 0o777, bakedSettingsMode: fs.statSync(process.argv[1] + "/settings.json").mode & 0o777 }));',
].join("\n");

it.effect(
  "the image bakes its config without config mounts; its relocated entrypoint gives private writable copies and HOME on tmpfs without inheriting a key",
  () =>
    Effect.gen(function* imageContract() {
      const fs = yield* FileSystem.FileSystem;
      const recipe = yield* fs.readFileString("Dockerfile");

      const copies = recipe
        .split("\n")
        .map((line) => line.trim().split(/\s+/u))
        .filter(([instruction]) => instruction === "COPY");

      expect(copies).toContainEqual(["COPY", "image/", "/opt/peon/"]);
      expect(recipe).toContain(
        "chmod 0444 /opt/peon/models.json /opt/peon/settings.json"
      );

      const root = yield* fs.makeTempDirectoryScoped({
        directory: process.cwd(),
        prefix: ".workspace-image-test-",
      });

      const baked = `${root}/opt/peon`;
      const home = `${root}/tmp/peon`;
      yield* fs.makeDirectory(baked, { recursive: true });
      yield* fs.makeDirectory(`${root}/tmp`);
      const modelsText = yield* fs.readFileString("image/models.json");
      const settingsText = yield* fs.readFileString("image/settings.json");
      yield* fs.writeFileString(`${baked}/models.json`, modelsText);
      yield* fs.writeFileString(`${baked}/settings.json`, settingsText);
      yield* fs.chmod(`${baked}/models.json`, 0o444);
      yield* fs.chmod(`${baked}/settings.json`, 0o444);

      const entrypoint = (yield* fs.readFileString("image/entrypoint.sh"))
        .replaceAll("/opt/peon", baked)
        .replaceAll("/tmp/peon", home);

      const script = `${root}/entrypoint.sh`;
      yield* fs.writeFileString(script, entrypoint);

      const result = yield* Runner.use(({ run }) =>
        run({
          args: [
            "HOME=/nonexistent",
            "ANTHROPIC_API_KEY=not-a-real-key",
            "/bin/sh",
            script,
            process.execPath,
            "-e",
            probe,
            baked,
          ],
          executable: "/usr/bin/env",
        })
      );

      expect(result.exit).toBe(0);

      const actual = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Probe)
      )(result.stdout);

      expect(actual).toEqual({
        agent: home,
        bakedModelsMode: 0o444,
        bakedSettingsMode: 0o444,
        canary: null,
        home,
        modelsMode: 0o600,
        modelsText,
        settingsMode: 0o600,
        settingsText,
      });

      const args = dockerArguments(image, `/exports/${sha}`, name, "medium");

      const mountFlags = args.filter((value) =>
        /^(?:-v|--volume|--mount|--tmpfs)(?:=|$)/u.test(value)
      );

      expect(mountFlags).toEqual(["--tmpfs", "-v"]);
      expect(args[args.indexOf("--tmpfs") + 1]).toBe("/tmp:size=256m");
      expect(args[args.indexOf("-v") + 1]).toBe(`/exports/${sha}:/work:ro`);
      expect(args).not.toContain("-e");
      expect(args).not.toContain("--env");
      expect(args).not.toContain("--env-file");
    }).pipe(
      Effect.scoped,
      Effect.provide(Runner.layer.pipe(Layer.provideMerge(NodeServices.layer)))
    )
);
