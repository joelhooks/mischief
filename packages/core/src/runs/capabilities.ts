import { implement } from "@mischief/capability/implement";

import {
  abortRunContract,
  answerRunContract,
  deliverReplyContract,
  extendRunContract,
  inspectRunContract,
  pauseRunContract,
  resumeRunContract,
  reviseRunContract,
  submitPlanContract,
} from "./contracts.js";
import { RunHost } from "./host.js";

export const submitPlan = implement(
  submitPlanContract,
  ({ docs, plan, runId }) =>
    RunHost.use((host) => host.submit(runId, plan, docs))
);

export const inspectRun = implement(inspectRunContract, ({ runId }) =>
  RunHost.use((host) => host.inspect(runId))
);

export const pauseRun = implement(pauseRunContract, ({ runId }) =>
  RunHost.use((host) => host.pause(runId))
);

export const resumeRun = implement(resumeRunContract, ({ runId }) =>
  RunHost.use((host) => host.resume(runId))
);

export const abortRun = implement(abortRunContract, ({ runId }) =>
  RunHost.use((host) => host.abort(runId))
);

export const answerRun = implement(answerRunContract, ({ reply, runId }) =>
  RunHost.use((host) => host.answer(runId, reply))
);

export const deliverReply = implement(deliverReplyContract, (line) =>
  RunHost.use((host) => host.deliver(line))
);

export const extendRun = implement(extendRunContract, ({ maxSteps, runId }) =>
  RunHost.use((host) => host.extend(runId, maxSteps))
);

export const reviseRun = implement(
  reviseRunContract,
  ({ dryRun, plan, runId }) =>
    RunHost.use((host) => host.revise(runId, plan, dryRun))
);

export const runCapabilities = [
  submitPlan,
  inspectRun,
  pauseRun,
  resumeRun,
  abortRun,
  answerRun,
  deliverReply,
  extendRun,
  reviseRun,
] as const;
