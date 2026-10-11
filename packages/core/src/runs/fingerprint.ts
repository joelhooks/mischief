import { Effect, Option, Schema } from "effect";
import type { Crypto } from "effect";
import { Hex } from "effect/encoding";
import type { AnyActor } from "xstate";

export const canonical = (value: Schema.Json): string => {
  if (Schema.is(Schema.Array(Schema.Json))(value)) {
    return `[${value.map((item) => canonical(item)).join(",")}]`;
  }

  if (Schema.is(Schema.Record(Schema.String, Schema.Json))(value)) {
    const fields = Object.entries(value)
      .toSorted(([left], [right]) => (left < right ? -1 : 1))
      .map(([name, field]) => `${JSON.stringify(name)}:${canonical(field)}`);

    return `{${fields.join(",")}}`;
  }

  return JSON.stringify(value);
};

export const fingerprintOf = (crypto: Crypto.Crypto, value: Schema.Json) =>
  Effect.gen(function* fingerprint() {
    const digest = yield* crypto.digest(
      "SHA-256",
      new TextEncoder().encode(canonical(value))
    );

    return Hex.encode(digest);
  }).pipe(Effect.orDie);

const ActorStepSchema = Schema.Struct({
  options: Schema.Struct({ input: Schema.Unknown, src: Schema.String }),
});

const decodeJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Json)
);

export const stepOf = (actor: AnyActor): Schema.Json =>
  Schema.decodeUnknownOption(ActorStepSchema)(actor).pipe(
    Option.flatMap(({ options }) =>
      decodeJson(JSON.stringify({ input: options.input, src: options.src }))
    ),
    Option.getOrElse((): Schema.Json => null)
  );
