import { implement } from "@mischief/capability/implement";

import {
  abortRunContract,
  answerRunContract,
  inspectRunContract,
  pauseRunContract,
  resumeRunContract,
  submitPlanContract,
} from "./contracts.js";
import { RunHost } from "./host.js";

export const submitPlan = implement(submitPlanContract, ({ plan, runId }) =>
  RunHost.use((host) => host.submit(runId, plan))
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

export const runCapabilities = [
  submitPlan,
  inspectRun,
  pauseRun,
  resumeRun,
  abortRun,
  answerRun,
] as const;
