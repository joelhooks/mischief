import { BridgeFailure } from "@mischief/model-bridge/bridge-failure";
import { ResponsesRequestSchema } from "@mischief/model-bridge/protocol";
import { Effect, Schema } from "effect";

export const Sha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u));

export const WorkspaceSchema = Schema.Struct({ repo: Schema.String, sha: Sha });

export const WorkspaceRequestSchema = ResponsesRequestSchema.mapFields(
  (fields) => ({
    ...fields,
    model: Schema.String,
    reasoning: Schema.Struct({
      effort: Schema.Literals([
        "none",
        "minimal",
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

export const peonModelOf = (model: string) => {
  if (model === "sol" || model === "gpt-6.1-sol") {
    return Effect.succeed("peon/gpt-6.1-sol" as const);
  }

  if (model === "opus" || model === "claude-opus-5-5") {
    return Effect.succeed("claude-bridge/claude-opus-5-5" as const);
  }

  return Effect.fail(
    refusal(
      "Unsupported workspace model. Select sol (gpt-6.1-sol) or opus (claude-opus-5-5). Other Claude models are not enabled; retry with one of these aliases.",
      403
    )
  );
};

export const decodeRequest = (body: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(WorkspaceRequestSchema))(
    body,
    {
      onExcessProperty: "error",
    }
  ).pipe(
    Effect.mapError(() =>
      refusal(
        "Invalid workspace Responses request. Supply workspace.repo from MISCHIEF_WORKSPACE_MIRRORS, workspace.sha as exactly 40 lowercase hex characters (not a branch or short sha), at least one of read, grep, find, ls, bash, and Responses fields with model=sol or opus and stream=true."
      )
    ),
    Effect.tap((request) => peonModelOf(request.model))
  );
