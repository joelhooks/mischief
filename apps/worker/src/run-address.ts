import { Option, Schema } from "effect";

const decodeAddress = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      replyTo: Schema.optionalKey(Schema.String),
      runId: Schema.optionalKey(Schema.String),
    })
  )
);

export const runIdOf = (body: string) =>
  decodeAddress(body).pipe(
    Option.flatMap(({ replyTo, runId }) =>
      Option.orElse(Option.fromUndefinedOr(runId), () =>
        Option.fromUndefinedOr(
          replyTo?.includes("/") === true ? replyTo.split("/")[0] : undefined
        )
      )
    ),
    Option.filter((runId) => runId !== "")
  );

export const NO_RUN_ID =
  "this request names no run. Every run capability takes a JSON body with runId. deliverReply can find its run from replyTo only when replyTo is <runId>/<step>#<visit>; a Rat King message id (an ask sent as real mail, like 3mxoabjvtfwka) has no run in it, so add the run's runId (inspectRun shows the ask under awaiting). Add runId to the body and send it again; GET /openapi.json lists every capability";
