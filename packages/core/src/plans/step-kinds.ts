import { Context } from "effect";

export const STEP_KINDS_FLAG = "MISCHIEF_STEP_KINDS";

export const gatedStepKinds = ["call"] as const;

export type GatedStepKind = (typeof gatedStepKinds)[number];

const isGated = (name: string): name is GatedStepKind =>
  gatedStepKinds.some((kind) => kind === name);

export const stepKindsFrom = (
  text: string | undefined
): ReadonlySet<GatedStepKind> =>
  new Set(
    (text ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(isGated)
  );

export const EnabledStepKinds = Context.Reference<ReadonlySet<GatedStepKind>>(
  "@mischief/core/EnabledStepKinds",
  { defaultValue: () => new Set() }
);

export const stepKindOff = (where: string, kind: GatedStepKind) =>
  `${where}: step kind "${kind}" is off on this host. A host turns it on with ${STEP_KINDS_FLAG}=${kind}, and turning it on for real runs needs Joel's approval, so ask Joel before setting it. Until then, express this step with think or switch, then call submitPlan again`;
