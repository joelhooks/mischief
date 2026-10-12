import { Option, Schema } from "effect";

export const SCHEDULE_CAPABILITIES: ReadonlySet<string> = new Set([
  "createSchedule",
  "inspectSchedule",
  "completeSchedule",
]);

const decodeAddress = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ scheduleId: Schema.optionalKey(Schema.String) })
  )
);

export const scheduleIdOf = (body: string) =>
  decodeAddress(body).pipe(
    Option.flatMap(({ scheduleId }) => Option.fromUndefinedOr(scheduleId)),
    Option.filter((scheduleId) => scheduleId !== "")
  );

export const NO_SCHEDULE_ID =
  "this request names no schedule. createSchedule, inspectSchedule and completeSchedule each take a JSON body with scheduleId; add it and send the request again. GET /openapi.json lists every capability";
