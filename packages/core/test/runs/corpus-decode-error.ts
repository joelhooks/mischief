import { Schema } from "effect";

export class CorpusDecodeError extends Schema.TaggedError<CorpusDecodeError>()(
  "CorpusDecodeError",
  { path: Schema.String, reason: Schema.String }
) {
  override get message() {
    return `Could not gunzip migration corpus ${this.path}: ${this.reason}. Regenerate it with capture.ts or restore runs.json.gz from git.`;
  }
}
