import { Data } from "effect";

export class VerdictDeferred extends Data.TaggedError("VerdictDeferred")<{
  readonly to: string;
}> {
  private readonly onlyTheShadowJudgeDefers = true;
}
