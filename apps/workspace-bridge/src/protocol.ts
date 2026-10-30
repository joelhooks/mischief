import { BridgeFailure } from "@mischief/model-bridge/bridge-failure";
import { ResponsesRequestSchema } from "@mischief/model-bridge/protocol";
import { Effect, Schema } from "effect";

export const Sha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u));

export const WorkspaceSchema = Schema.Struct({ repo: Schema.String, sha: Sha });

export const WorkspaceRequestSchema = ResponsesRequestSchema.mapFields(
  (fields) => ({
    ...fields,
    reasoning: Schema.Struct({
      effort: Schema.Literals([
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]),
      summary: fields.reasoning.fields.summary,
    }).pipe(Schema.withDecodingDefaultKey(Effect.succeed({ effort: "none" }))),
    tools: Schema.Array(
      Schema.Literals(["read", "grep", "find", "ls", "bash"])
    ).check(Schema.isMinLength(1)),
    workspace: WorkspaceSchema,
  })
);

export type WorkspaceRequest = typeof WorkspaceRequestSchema.Type;

export type Workspace = typeof WorkspaceSchema.Type;

export const refusal = (
  message: string,
  status: BridgeFailure["status"] = 400
) => new BridgeFailure({ message, status });

export const decodeRequest = (body: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(WorkspaceRequestSchema))(
    body,
    {
      onExcessProperty: "error",
    }
  ).pipe(
    Effect.mapError(() =>
      refusal(
        "Invalid workspace Responses request. Supply workspace.repo from MISCHIEF_WORKSPACE_MIRRORS, workspace.sha as exactly 40 lowercase hex characters (not a branch or short sha), at least one of read, grep, find, ls, bash, and the Opus Responses fields with model=claude-opus-5-5 and stream=true."
      )
    )
  );
