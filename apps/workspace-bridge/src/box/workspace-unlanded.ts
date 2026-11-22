import { Schema } from "effect";

export class WorkspaceUnlanded extends Schema.TaggedError<WorkspaceUnlanded>()(
  "WorkspaceUnlanded",
  {
    dirtyPaths: Schema.Array(Schema.String),
    message: Schema.String,
    status: Schema.Literal(409),
  }
) {}
