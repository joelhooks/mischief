import { implement } from "@mischief/capability/implement";

import { thinkStatusContract } from "./contracts.js";
import { ThinkTelemetry } from "./telemetry.js";

export const thinkStatus = implement(thinkStatusContract, () =>
  ThinkTelemetry.use((telemetry) => telemetry.read)
);

export const thinkingCapabilities = [thinkStatus] as const;
