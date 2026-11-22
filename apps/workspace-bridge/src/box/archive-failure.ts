import { Schema } from "effect";

export class ArchiveFailure extends Schema.TaggedError<ArchiveFailure>()(
  "ArchiveFailure",
  { message: Schema.String }
) {}

export const archiveFailure = (message: string) =>
  new ArchiveFailure({ message });
