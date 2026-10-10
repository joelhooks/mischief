import { defineContract } from "@mischief/capability/contract";
import { Schema } from "effect";

import { FileStatsError, FileStatsSchema } from "./stats.js";

export const inspectFileContract = defineContract("inspectFile", {
  annotations: { idempotent: true, readOnly: true },
  description: "Count bytes, characters, words, and lines in a file",
  failure: FileStatsError,
  input: Schema.Struct({
    path: Schema.String.annotate({ description: "File to inspect" }),
  }),
  output: FileStatsSchema,
});
