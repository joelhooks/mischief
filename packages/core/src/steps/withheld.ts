import { Schema } from "effect";

import { ProviderUnavailable } from "./provider-unavailable.js";
import { StepFailed } from "./step-failed.js";

export type UnrecordedStage = "ephemeral" | "model" | "post";

const HTTP_STATUS = /\bHTTP (?<status>[1-5]\d{2})\b/u;

const statusIn = (reason: string) => {
  const found = HTTP_STATUS.exec(reason)?.groups?.status;

  return found === undefined ? "" : ` with HTTP ${found}`;
};

const WHY =
  "The reason is withheld because it can quote the ephemeral input or the model's raw answer, which this run never records";

const STAGES: Readonly<
  Record<UnrecordedStage, (capability: string) => string>
> = {
  ephemeral: (capability) =>
    `its ephemeral fetch through capability "${capability}" failed`,
  model: () => "its unrecorded model call failed",
  post: (capability) =>
    `its post step through capability "${capability}" failed`,
};

const NEXT: Readonly<Record<UnrecordedStage, (capability: string) => string>> =
  {
    ephemeral: (capability) => `Check capability "${capability}" on this host`,
    model: () => "Check this step's model mapping and credentials on this host",
    post: (capability) => `Check capability "${capability}" on this host`,
  };

export const withheldFailure =
  (key: string, stage: UnrecordedStage, capability: string) =>
  (failure: StepFailed) =>
    new StepFailed({
      key,
      reason: `${STAGES[stage](capability)}${statusIn(failure.reason)}. ${WHY}. ${NEXT[stage](capability)}`,
    });

export const withheldOutage = (outage: ProviderUnavailable) =>
  new ProviderUnavailable({
    cause: outage.cause,
    error: `${outage.provider} is unavailable${outage.status === null ? "" : ` with HTTP ${outage.status}`}; its error text is withheld because it can quote an unrecorded request`,
    key: outage.key,
    provider: outage.provider,
    retryAfter: outage.retryAfter,
    status: outage.status,
  });

export const withheldThink =
  (key: string) => (failure: StepFailed | ProviderUnavailable) =>
    Schema.is(ProviderUnavailable)(failure)
      ? withheldOutage(failure)
      : withheldFailure(key, "model", "")(failure);
