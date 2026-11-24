import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Path } from "effect";

import { boxRunnerLayer } from "../src/box/runner.js";
import { Runner } from "../src/runner.js";

it.effect(
  "browser launcher refuses empty or wildcard hosts and prints the same flags Burrow consumes",
  () =>
    Effect.gen(function* browserLaunch() {
      const path = yield* Path.Path;
      const runner = yield* Runner;

      const launcher = path.join(
        import.meta.dirname,
        "../image/browser/peon-browser"
      );

      const launch = (hosts: string) =>
        runner.run({
          executable: "env",
          args: [
            `PEON_BROWSER_HOSTS=${hosts}`,
            "/bin/sh",
            launcher,
            "--launch-flags",
          ],
        });

      for (const hosts of [
        "",
        "*.example.test",
        "127.0.0.1",
        "allowed.test EXCLUDE *",
      ]) {
        const result = yield* launch(hosts);
        expect(result.exit).toBe(2);
        expect(result.stdout).toBe("");
      }

      const result = yield* launch("qa.example.test assets.example.test");
      expect(result.exit).toBe(0);
      expect(result.stdout.trimEnd().split("\n")).toEqual([
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--proxy-server=http://127.0.0.1:9",
        "--proxy-bypass-list=qa.example.test;assets.example.test;<-loopback>",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE qa.example.test, EXCLUDE assets.example.test",
      ]);
    }).pipe(
      Effect.provide(
        boxRunnerLayer().pipe(Layer.provideMerge(NodeServices.layer))
      )
    )
);
