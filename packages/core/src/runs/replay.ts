import { Option, Schema } from "effect";

import { docRefs } from "../plans/doc-refs.js";
import {
  WhySchema,
  askedDocName,
  reasonDocName,
  whyDocName,
} from "../steps/judge.js";

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
    ephemeral: Schema.optionalKey(
      Schema.Struct({ reads: Schema.optionalKey(Schema.Array(Schema.String)) })
    ),
    reads: Schema.optionalKey(
      Schema.Union([Schema.String, Schema.Array(Schema.String)])
    ),
  }),
});

const decodeReads = Schema.decodeUnknownOption(ReadsSchema);

const namesOf = (
  names: string | readonly string[] | undefined
): readonly string[] => {
  if (names === undefined) {
    return [];
  }

  return isText(names) ? [names] : names;
};

export const docsRead = (step: Schema.Json): readonly string[] => {
  const reads = decodeReads(step).pipe(
    Option.map(({ input }) => [
      ...namesOf(input.reads),
      ...namesOf(input.ephemeral?.reads),
    ]),
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

const CalledSchema = Schema.Struct({
  output: Schema.Struct({ output: Schema.Json }),
  step: Schema.Struct({
    input: Schema.Struct({ writes: Schema.String }),
    src: Schema.Literal("call"),
  }),
});

const decodeCalled = Schema.decodeUnknownOption(CalledSchema);

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

const JudgedSchema = Schema.Struct({
  output: Schema.Struct({ why: WhySchema }),
  step: Schema.Struct({
    input: Schema.Struct({ key: Schema.String }),
    src: Schema.Literal("judge"),
  }),
});

const decodeThink = Schema.decodeUnknownOption(ThinkSchema);

const AskedSchema = Schema.Struct({
  output: Schema.Struct({ asked: Schema.String }),
  step: Schema.Struct({
    input: Schema.Struct({ key: Schema.String }),
    src: Schema.Literal("judge"),
  }),
});

const ReasonSchema = Schema.Struct({
  output: Schema.Struct({ reason: Schema.String }),
  step: AskedSchema.fields.step,
});

const decodeJudged = Schema.decodeUnknownOption(JudgedSchema);

const decodeReason = Schema.decodeUnknownOption(ReasonSchema);

const decodeAsked = Schema.decodeUnknownOption(AskedSchema);

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
    ...Option.toArray(decodeCalled(done)).map(
      (called) => [called.step.input.writes, called.output.output] as const
    ),
    ...Option.toArray(decodeAsk(done)).map(
      (sent) =>
        [
          `__sent:${sent.step.input.key}`,
          { messageId: sent.output.messageId, to: sent.step.input.to },
        ] as const
    ),
    ...Option.toArray(decodeJudged(done)).map(
      (verdict) =>
        [whyDocName(verdict.step.input.key), [...verdict.output.why]] as const
    ),
    ...Option.toArray(decodeAsked(done)).map(
      (verdict) =>
        [askedDocName(verdict.step.input.key), verdict.output.asked] as const
    ),
    ...Option.toArray(decodeReason(done)).map(
      (verdict) =>
        [reasonDocName(verdict.step.input.key), verdict.output.reason] as const
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
