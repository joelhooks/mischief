import { expect, it } from "@effect/vitest";
import type { VerdictDeferred } from "@mischief/core";
import * as Core from "@mischief/core";
import { Data } from "effect";

class LookAlike extends Data.TaggedError("VerdictDeferred")<{
  readonly to: string;
}> {}

type Forgeable = LookAlike extends VerdictDeferred ? true : false;

export const lookAlikeIsNotADeferral: Forgeable = false;

it("only core's shadow judge can defer a verdict", () => {
  expect("VerdictDeferred" in Core).toBe(false);
});
