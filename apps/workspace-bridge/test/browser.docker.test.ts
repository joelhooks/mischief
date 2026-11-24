import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { describe } from "vitest";

import { BoxImages } from "../src/box/config.js";
import { boxRunnerLayer } from "../src/box/runner.js";
import { checked } from "../src/runner.js";

const image = process.env.MISCHIEF_REAL_DOCKER_BROWSER_IMAGE;

const docker = (args: readonly string[]) =>
  checked({ args, executable: "docker" });

describe.skipIf(image === undefined || image === "")(
  "real Docker browser image",
  () => {
    it.live(
      "screenshots a data URL under default seccomp with the browser launch flags",
      () =>
        Effect.gen(function* screenshot() {
          const pinned = yield* Schema.decodeUnknownEffect(
            BoxImages.fields.full
          )(image);

          const id = yield* Effect.acquireRelease(
            docker([
              "create",
              "--pull=never",
              "--network",
              "none",
              "--read-only",
              "--tmpfs",
              "/tmp:rw,nosuid,nodev,size=2g",
              "--cap-drop",
              "ALL",
              "--security-opt",
              "no-new-privileges",
              "--user",
              "65534:65534",
              "--pids-limit",
              "1024",
              "--memory",
              "4g",
              "--cpus",
              "4",
              "--env",
              "PEON_BROWSER_HOSTS=test.example",
              "--env",
              "HOME=/tmp",
              "--env",
              "XDG_CONFIG_HOME=/tmp/config",
              "--env",
              "XDG_CACHE_HOME=/tmp/cache",
              pinned,
            ]).pipe(Effect.map((stdout) => stdout.trim())),
            (container) =>
              docker(["rm", "--force", container]).pipe(Effect.orDie)
          );

          const options = yield* docker([
            "inspect",
            "--format",
            "{{json .HostConfig.SecurityOpt}} {{json .HostConfig.CapAdd}}",
            id,
          ]);

          process.stdout.write(`browser SecurityOpt CapAdd: ${options}`);
          expect(options.trim()).toBe('["no-new-privileges"] null');
          yield* docker(["start", id]);
          yield* docker([
            "exec",
            id,
            "/usr/local/bin/peon-browser",
            "--headless=new",
            "--disable-gpu",
            "--user-data-dir=/tmp/profile",
            "--screenshot=/tmp/proof.png",
            "data:text/html,<h1>Peon browser proof</h1>",
          ]);

          const signature = yield* docker([
            "exec",
            id,
            "od",
            "-An",
            "-tx1",
            "-N8",
            "/tmp/proof.png",
          ]);

          expect(signature.trim()).toBe("89 50 4e 47 0d 0a 1a 0a");
        }).pipe(
          Effect.scoped,
          Effect.provide(
            boxRunnerLayer().pipe(Layer.provideMerge(NodeServices.layer))
          )
        ),
      60_000
    );
  }
);
