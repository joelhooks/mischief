import { isOutput } from "alchemy/Output";
import * as Plan from "alchemy/Plan";
import { Crypto, Effect, Redacted, Schema } from "effect";
import { encode } from "effect/encoding/Hex";

const BIG = 4096;

const isText = Schema.is(Schema.String);

const isList = Schema.is(Schema.Array(Schema.Unknown));

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

export interface ReviewRow {
  readonly action: string;
  readonly fqn: string;
  readonly props: unknown;
  readonly type: string;
}

const digestOf = (crypto: Crypto.Crypto, text: string) =>
  crypto
    .digest("SHA-256", new TextEncoder().encode(text))
    .pipe(Effect.map(encode), Effect.orDie);

const shown = (
  crypto: Crypto.Crypto,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a plan review renders whatever props each provider declared; there is no single schema to parse them with.
  value: unknown
): Effect.Effect<unknown> => {
  if (Redacted.isRedacted(value)) {
    return Effect.succeed("<redacted>");
  }

  if (isOutput(value)) {
    return Effect.succeed("<output>");
  }

  if (isText(value) && value.length > BIG) {
    return digestOf(crypto, value).pipe(
      Effect.map((sha256) => ({ length: value.length, sha256 }))
    );
  }

  if (isList(value)) {
    return Effect.all(value.map((item) => shown(crypto, item)));
  }

  if (isRecord(value)) {
    return Effect.all(
      Object.entries(value).map(([key, item]) =>
        shown(crypto, item).pipe(Effect.map((seen) => [key, seen] as const))
      )
    ).pipe(Effect.map((entries) => Object.fromEntries(entries)));
  }

  return Effect.succeed(value);
};

export const reviewRows = (plan: Plan.Plan) =>
  Effect.gen(function* rows() {
    const crypto = yield* Crypto.Crypto;

    return yield* Effect.all(
      Plan.describePlan(plan).resources.map((row) => {
        const node = plan.resources[row.fqn];

        const props: unknown =
          node !== undefined && "props" in node ? node.props : null;

        return shown(crypto, props).pipe(
          Effect.map((seen): ReviewRow => ({
            action: row.action,
            fqn: row.fqn,
            props: seen,
            type: row.resourceType,
          }))
        );
      })
    );
  });
