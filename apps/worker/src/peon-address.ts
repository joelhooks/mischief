import { PeonId } from "@mischief/core";
import { Option, Schema } from "effect";

const Address = Schema.fromJsonString(
  Schema.Struct({
    body: Schema.optionalKey(Schema.String),
    peonId: Schema.optionalKey(PeonId),
    text: Schema.optionalKey(Schema.String),
    thread: Schema.optionalKey(Schema.String),
  })
);

export const resolvePeonAddress = (
  thread: string | undefined,
  body: string,
  instance?: string
) => {
  const outer = Schema.decodeOption(Address)(body).pipe(Option.getOrUndefined);

  const inside = Schema.decodeOption(Address)(outer?.body ?? "").pipe(
    Option.getOrUndefined
  );

  const id = instance ?? outer?.peonId ?? inside?.peonId;

  const key = thread ?? outer?.thread;

  const peonId = Schema.decodeUnknownOption(PeonId)(
    id ?? (key?.startsWith("peon:") === true ? key.slice(5) : undefined)
  );

  const text = inside?.text ?? outer?.text ?? outer?.body ?? body;

  return peonId.pipe(Option.map((value) => ({ peonId: value, text })));
};
