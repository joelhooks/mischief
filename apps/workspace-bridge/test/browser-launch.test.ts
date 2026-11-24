import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Path } from "effect";

import { browserEgressFlags } from "../src/box/browser.js";
import { boxRunnerLayer } from "../src/box/runner.js";
import { Runner } from "../src/runner.js";

it.effect(
  "the shared egress helper refuses invalid hosts and the launcher keeps each flag intact",
  () =>
    Effect.gen(function* browserLaunch() {
      for (const hosts of [
        [],
        ["*.example.test"],
        ["127.0.0.1"],
        ["allowed.test EXCLUDE *"],
      ]) {
        const error = yield* Effect.flip(browserEgressFlags(hosts));
        expect(error.message).toContain("exact test DNS hosts");
      }

      const expected = [
        "--proxy-server=http://127.0.0.1:9",
        "--proxy-bypass-list=qa.example.test;assets.example.test;<-loopback>",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE qa.example.test, EXCLUDE assets.example.test",
      ];

      const flags = yield* browserEgressFlags([
        "qa.example.test",
        "assets.example.test",
      ]);

      expect(flags.split("\n")).toEqual(expected);

      const path = yield* Path.Path;
      const runner = yield* Runner;

      const launcher = path.join(
        import.meta.dirname,
        "../image/browser/peon-browser"
      );

      const launch = (value: string) =>
        runner.run({
          executable: "env",
          args: [
            `PEON_BROWSER_EGRESS_FLAGS=${value}`,
            "/bin/sh",
            launcher,
            "--launch-flags",
          ],
        });

      const missing = yield* launch("");
      expect(missing.exit).toBe(2);
      expect(missing.stdout).toBe("");

      const result = yield* launch(flags);
      expect(result.exit).toBe(0);
      expect(result.stdout.trimEnd().split("\n")).toEqual([
        "--no-sandbox",
        "--disable-dev-shm-usage",
        ...expected,
      ]);
    }).pipe(
      Effect.provide(
        boxRunnerLayer().pipe(Layer.provideMerge(NodeServices.layer))
      )
    )
);
