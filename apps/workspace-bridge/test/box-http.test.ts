import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Effect,
  Layer,
  Predicate,
  Redacted,
  Ref,
  Schema,
  Tracer,
} from "effect";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import { requireSuccess } from "../../worker/src/peon-box.js";
import { BoxBuildRefused } from "../src/box/box-build-refused.js";
import { BoxCapacity } from "../src/box/box-capacity.js";
import { CustodyMissing } from "../src/box/custody-missing.js";
import { CustodyIncomplete } from "../src/box/custody-refusal.js";
import { DestroyInProgress } from "../src/box/destroy-in-progress.js";
import { boxRoutes } from "../src/box/http.js";
import { Boxes } from "../src/box/manager.js";
import { PromptFailed } from "../src/box/prompt-failed.js";
import { Result } from "../src/box/protocol.js";
import { ReceiptMismatch } from "../src/box/receipt-mismatch.js";
import { WorkspaceUnlanded } from "../src/box/workspace-unlanded.js";
import { sha } from "./fixtures.js";

it.effect(
  "box control authenticates before dispatch and validates pinned full templates and safe path identifiers",
  () =>
    Effect.gen(function* boundary() {
      const calls = yield* Ref.make<string[]>([]);

      const exportReceipt = {
        id: "peon/example",
        location: "/fixture/primary",
        mirror: "/fixture/mirror",
        sha256: "a".repeat(64),
      };

      const refusals = [
        new CustodyMissing({ dir: "fixture", message: "missing", status: 503 }),
        new CustodyIncomplete({
          skipped: [{ path: "fixture", reason: "unreadable" }],
          message: "incomplete",
          status: 409,
        }),
        new DestroyInProgress({
          requestId: "previous",
          disposition: "discardWorkspace",
          retained: false,
          message: "retry",
          status: 409,
        }),
        new PromptFailed({
          message: "Provider unavailable",
          state: "suspended",
          status: 503,
        }),
        new ReceiptMismatch({
          reason: "changed",
          message: "mismatch",
          status: 409,
        }),
        new WorkspaceUnlanded({
          dirtyPaths: ["fixture"],
          dirtyTotal: 1,
          refs: [],
          message: "unlanded",
          status: 409,
        }),
      ];

      const browserRefusals = [
        new BoxCapacity({
          message: "Browser slots occupied",
          state: "suspended",
          status: 429,
        }),
        new BoxBuildRefused({
          message: "Burrow receipt failed",
          state: "hibernated",
          status: 409,
        }),
      ];

      const boxes = Boxes.of({
        act: (input) => {
          const refused = [...refusals, ...browserRefusals].find(
            (failure) => failure._tag === input.requestId
          );

          if (refused !== undefined) {
            return Effect.fail(refused);
          }

          return Ref.update(calls, (values) => [...values, input.action]).pipe(
            Effect.as(
              input.action === "export"
                ? { exportReceipt, state: "suspended" }
                : { state: "idle" }
            )
          );
        },
        create: (input) =>
          Effect.sync(() => {
            expect(input.template.limits.tmp).toBe("1g");
          }).pipe(
            Effect.andThen(
              Ref.update(calls, (values) => [...values, "create"])
            ),
            Effect.as({ peonId: input.peonId, state: "idle" })
          ),
        inspect: () =>
          Ref.update(calls, (values) => [...values, "inspect"]).pipe(
            Effect.as({ processes: 0, state: "suspended" })
          ),
        ownerAt: () =>
          Effect.die("Unexpected owner lookup in the lifecycle route test"),
        tail: () =>
          Effect.die("Unexpected tail call in the lifecycle route test"),
      });

      yield* HttpRouter.serve(boxRoutes(Redacted.make("box-secret")), {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.provide(Layer.succeed(Boxes, boxes)), Layer.build);

      const template = {
        limits: { cpus: 2, memory: "4g", pids: 512, tmp: "1g" },
        model: "opus",
        thinking: "medium",
        tools: "all",
        workspace: { repo: "example/review", sha },
      };

      const body = { peonId: "peon", requestId: "create", template };

      const unauthenticated = yield* HttpClient.post("/v1/boxes", {
        body: HttpBody.jsonUnsafe(body),
      });

      expect(unauthenticated.status).toBe(401);
      expect(yield* Ref.get(calls)).toEqual([]);
      const headers = { authorization: "Bearer box-secret" };

      for (const invalid of [
        { ...body, peonId: "../peon" },
        { ...body, requestId: "" },
        { ...body, requestId: "x".repeat(513) },
        { ...body, template: { ...template, tools: "read-only" } },
        {
          ...body,
          template: {
            ...template,
            workspace: { ...template.workspace, sha: "main" },
          },
        },
        {
          ...body,
          template: { ...template, limits: { ...template.limits, cpus: 0 } },
        },
        ...["0g", "-1g", "1g,exec", "1gb", "1.5g"].map((tmp) => ({
          ...body,
          template: { ...template, limits: { ...template.limits, tmp } },
        })),
        {
          ...body,
          template: {
            ...template,
            warm: { docs: [{ path: "../../escape", text: "unsafe" }] },
          },
        },
        { ...body, template: { ...template, suspendAfter: 60_000 } },
      ]) {
        const rejected = yield* HttpClient.post("/v1/boxes", {
          body: HttpBody.jsonUnsafe(invalid),
          headers,
        });

        expect(rejected.status).toBe(400);
      }

      expect(yield* Ref.get(calls)).toEqual([]);
      expect(
        (yield* HttpClient.post("/v1/boxes", {
          body: HttpBody.jsonUnsafe(body),
          headers,
        })).status
      ).toBe(200);
      expect(
        (yield* HttpClient.post("/v1/boxes", {
          body: HttpBody.jsonUnsafe({
            ...body,
            template: {
              ...template,
              limits: { cpus: 2, memory: "4g", pids: 512 },
            },
          }),
          headers,
        })).status
      ).toBe(200);
      expect(
        (yield* HttpClient.get("/v1/boxes/peon", { headers })).status
      ).toBe(200);
      expect(
        (yield* HttpClient.post("/v1/boxes/peon/prompt", {
          body: HttpBody.jsonUnsafe({ requestId: "turn", text: "task" }),
          headers,
        })).status
      ).toBe(200);

      const exported = yield* HttpClient.post("/v1/boxes/peon/export", {
        body: HttpBody.jsonUnsafe({}),
        headers,
      });

      expect(exported.status).toBe(200);

      const decoded = yield* Schema.decodeUnknownEffect(Result)(
        yield* exported.json
      );

      expect(decoded.exportReceipt).toEqual(exportReceipt);
      expect(
        (yield* HttpClient.del("/v1/boxes/peon", {
          body: HttpBody.jsonUnsafe({ requestId: "destroy" }),
          headers,
        })).status
      ).toBe(200);

      for (const failure of refusals) {
        const response = yield* Predicate.isTagged(failure, "PromptFailed")
          ? HttpClient.post("/v1/boxes/peon/prompt", {
              body: HttpBody.jsonUnsafe({
                requestId: failure._tag,
                text: "work",
              }),
              headers,
            })
          : HttpClient.del("/v1/boxes/peon", {
              body: HttpBody.jsonUnsafe({
                requestId: failure._tag,
                discardWorkspace: true,
              }),
              headers,
            });

        expect(response.status).toBe(failure.status);

        const errorBody = yield* response.json;
        expect(errorBody).toMatchObject({
          error: { code: failure._tag, message: failure.message },
        });

        if (Predicate.isTagged(failure, "PromptFailed")) {
          expect(errorBody).toMatchObject({ error: { state: "suspended" } });
        }
      }

      for (const failure of browserRefusals) {
        const response = yield* HttpClient.post("/v1/boxes/peon/resume", {
          body: HttpBody.jsonUnsafe({ requestId: failure._tag }),
          headers,
        });

        expect(response.status).toBe(failure.status);

        const decodedRefusal = yield* Effect.flip(
          requireSuccess("peon", "resume", {
            status: response.status,
            text: yield* response.text,
          })
        );

        expect(decodedRefusal.code).toBe(failure._tag);
        expect(decodedRefusal.boxState).toBe(failure.state);
        expect(decodedRefusal.reason).toContain(`HTTP ${failure.status}`);
      }

      expect(yield* Ref.get(calls)).toEqual([
        "create",
        "create",
        "inspect",
        "prompt",
        "export",
        "destroy",
      ]);
    }).pipe(
      Effect.scoped,
      Effect.provide(NodeHttpServer.layerTest),
      Effect.provideService(Tracer.DisablePropagation, true)
    )
);
