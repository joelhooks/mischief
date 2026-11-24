import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  BoxDnsRefused,
  checkBoxCreateDns,
} from "../src/box/box-dns-refused.js";
import { BOX_NETWORK, BROWSER_BOX_NETWORK } from "../src/box/live-owner.js";

const createArgs = (dns: readonly string[]) => [
  "create",
  "--network",
  "mischief-peon-browser",
  ...dns,
  "--entrypoint",
  "/bin/sleep",
  "browser-fixture",
  "infinity",
];

it.effect(
  "refuses a browser create unless Docker gets exactly one gateway DNS flag",
  () =>
    Effect.gen(function* browserCreateDns() {
      const gateway = "172.30.213.1";

      yield* checkBoxCreateDns(
        BROWSER_BOX_NETWORK,
        createArgs(["--dns", gateway])
      );

      for (const dns of [
        [],
        ["--dns"],
        ["--dns", "1.1.1.1"],
        ["--dns", `${gateway},1.1.1.1`],
        [`--dns=${gateway}`],
        ["--dns", gateway, "--dns", gateway],
        ["--dns", gateway, "--dns=1.1.1.1"],
      ]) {
        const failure = yield* Effect.flip(
          checkBoxCreateDns(BROWSER_BOX_NETWORK, createArgs(dns))
        );

        expect(failure).toBeInstanceOf(BoxDnsRefused);
        expect(failure.status).toBe(503);
        expect(failure.message).toContain("exactly one --dns 172.30.213.1");
      }

      yield* checkBoxCreateDns(BOX_NETWORK, [
        "create",
        "--network",
        "mischief-peon-boxes",
        "--dns",
        "1.1.1.1",
        "--dns",
        "9.9.9.9",
        "full-fixture",
      ]);
    })
);
