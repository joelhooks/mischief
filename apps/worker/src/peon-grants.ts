import { peonCapabilityNames } from "@mischief/core";
import { Option, Schema } from "effect";

const PeonGrants = Schema.Record(
  Schema.String,
  Schema.Array(
    Schema.String.check(
      Schema.makeFilter((name) => peonCapabilityNames.has(name))
    )
  )
);

export const peonGranted = (
  grants: string | undefined,
  owner: string,
  capability: string
) =>
  Option.exists(
    Schema.decodeUnknownOption(Schema.fromJsonString(PeonGrants))(
      grants ?? "{}"
    ),
    (value) => value[owner]?.includes(capability) === true
  );
