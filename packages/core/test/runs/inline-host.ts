import { Effect, Layer } from "effect";

import { Drive } from "../../src/runs/drive.js";
import { RunHost } from "../../src/runs/host.js";
import { RedriveAttempts } from "../../src/runs/redrive.js";

export class InlineRunHost extends RunHost {
  static override readonly make = RunHost.make.pipe(
    Effect.provide(Drive.inline),
    Effect.provideService(RedriveAttempts, Number.MAX_SAFE_INTEGER)
  );

  static override readonly layer = Layer.effect(this, this.make);
}
