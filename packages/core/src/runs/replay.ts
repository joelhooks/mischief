import { Option, Schema } from "effect";

import { docRefs } from "../plans/doc-refs.js";

const isText = Schema.is(Schema.String);

const isList = Schema.is(Schema.Array(Schema.Json));

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Json));

const textsIn = (value: Schema.Json): readonly string[] => {
  if (isText(value)) {
    return [value];
  }

  if (isList(value)) {
    return value.flatMap((item) => textsIn(item));
  }

  return isRecord(value)
    ? Object.values(value).flatMap((item) => textsIn(item))
    : [];
};

const ReadsSchema = Schema.Struct({
  input: Schema.Struct({
    reads: Schema.optionalKey(
      Schema.Union([Schema.String, Schema.Array(Schema.String)])
    ),
  }),
});

const decodeReads = Schema.decodeUnknownOption(ReadsSchema);

export const docsRead = (step: Schema.Json): readonly string[] => {
  const reads = decodeReads(step).pipe(
    Option.flatMap(({ input }) => Option.fromUndefinedOr(input.reads)),
    Option.map((names) => (isText(names) ? [names] : names)),
    Option.getOrElse((): readonly string[] => [])
  );

  return [...new Set([...textsIn(step).flatMap(docRefs), ...reads])].toSorted();
};

const ThinkSchema = Schema.Struct({
  output: Schema.Struct({ output: Schema.Json }),
  step: Schema.Struct({
    input: Schema.Struct({ writes: Schema.String }),
    src: Schema.Literal("think"),
  }),
});

const AskSchema = Schema.Struct({
  output: Schema.Struct({ messageId: Schema.String }),
  step: Schema.Struct({
    input: Schema.Struct({ key: Schema.String, to: Schema.String }),
    src: Schema.Literal("ask"),
  }),
});

const ElaborateSchema = Schema.Struct({
  output: Schema.Struct({ amendment: Schema.Json }),
  step: Schema.Struct({
    input: Schema.Struct({ key: Schema.String }),
    src: Schema.Literal("elaborate"),
  }),
});

const decodeThink = Schema.decodeUnknownOption(ThinkSchema);

const decodeAsk = Schema.decodeUnknownOption(AskSchema);

const decodeElaborate = Schema.decodeUnknownOption(ElaborateSchema);

export const docWrites = (
  step: Schema.Json,
  output: Schema.Json
): readonly (readonly [string, Schema.Json])[] => {
  const done = { output, step };

  return [
    ...Option.toArray(decodeThink(done)).map(
      (thought) => [thought.step.input.writes, thought.output.output] as const
    ),
    ...Option.toArray(decodeAsk(done)).map(
      (sent) =>
        [
          `__sent:${sent.step.input.key}`,
          { messageId: sent.output.messageId, to: sent.step.input.to },
        ] as const
    ),
    ...Option.toArray(decodeElaborate(done)).map(
      (result) =>
        [
          `__amendment:${result.step.input.key}`,
          result.output.amendment,
        ] as const
    ),
  ];
};
