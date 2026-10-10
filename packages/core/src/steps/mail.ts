import { Context } from "effect";
import type { Effect } from "effect";

import type { StepCall, StepFailed } from "./step-failed.js";

export class Mail extends Context.Service<
  Mail,
  {
    readonly ask: (
      call: StepCall & { readonly message: string; readonly to: string }
    ) => Effect.Effect<string, StepFailed>;
  }
>()("@mischief/core/Mail") {}
