import { DurableObject } from "cloudflare:workers";

export class WatchObject extends DurableObject {
  // oxlint-disable-next-line eslint/class-methods-use-this -- The platform calls fetch on the instance; refusal must not touch instance state.
  override fetch(_request: Request): Response {
    return Response.json(
      {
        code: "WatchesDisabled",
        error: "Watches are disabled on this rollback worker.",
      },
      { status: 503 }
    );
  }

  // oxlint-disable-next-line eslint/class-methods-use-this, eslint/no-empty-function -- The platform calls alarm on the instance; rollback must not touch instance state.
  override alarm(): void {}
}
