import { Effect, Option, Schema } from "effect";

import { DocKey } from "../plans/schema.js";
import { PlanRefused, validatePlan } from "../plans/validate.js";
import type { Docs } from "./schema.js";

const decodeJsonObject = Schema.decodeUnknownOption(Schema.JsonObject);

const docKeyGuard = Schema.is(DocKey);

const isDocKey = (name: string): boolean => docKeyGuard(name);

export const checkSubmission = Effect.fn("checkSubmission")(
  function* checkSubmission(input: Schema.Json, docs: Docs) {
    const badNames = Object.keys(docs).filter((name) => !isDocKey(name));

    if (badNames.length > 0) {
      return yield* new PlanRefused({
        errors: badNames.map(
          (name) =>
            `docs.${name}: seed doc names are lowercase, start with a letter and use only a-z, 0-9, _ and -, up to 64 characters`
        ),
      });
    }

    return yield* validatePlan(
      Option.match(decodeJsonObject(input), {
        onNone: () => input,
        onSome: (fields) => ({ ...fields, version: 1 }),
      }),
      Object.keys(docs)
    );
  }
);
