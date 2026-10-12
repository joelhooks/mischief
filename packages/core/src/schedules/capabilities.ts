import { implement } from "@mischief/capability/implement";

import {
  completeScheduleContract,
  createScheduleContract,
  inspectScheduleContract,
} from "./contracts.js";
import {
  completeSchedule as complete,
  createSchedule as create,
  inspectSchedule as inspect,
} from "./host.js";

export const createSchedule = implement(createScheduleContract, (input) =>
  create(input)
);

export const inspectSchedule = implement(
  inspectScheduleContract,
  ({ scheduleId }) => inspect(scheduleId)
);

export const completeSchedule = implement(
  completeScheduleContract,
  ({ scheduleId }) => complete(scheduleId)
);

export const scheduleCapabilities = [
  createSchedule,
  inspectSchedule,
  completeSchedule,
] as const;
