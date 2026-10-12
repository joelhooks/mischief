import { expect, it } from "@effect/vitest";
import { Option } from "effect";

import { runIdOf } from "../src/run-address.js";

it("a reply finds its run from runId, or from an outbox replyTo, but never mistakes a Rat King id for a run name", () => {
  expect(runIdOf('{"runId":"cc2","replyTo":"3mxoabjvtfwka"}')).toStrictEqual(
    Option.some("cc2")
  );
  expect(runIdOf('{"replyTo":"cc2/verify#1"}')).toStrictEqual(
    Option.some("cc2")
  );
  expect(runIdOf('{"replyTo":"3mxoabjvtfwka"}')).toStrictEqual(Option.none());
  expect(runIdOf('{"replyTo":""}')).toStrictEqual(Option.none());
  expect(runIdOf("{}")).toStrictEqual(Option.none());
});
