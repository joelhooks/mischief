import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Redacted, Ref, Tracer } from "effect";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import { boxRoutes } from "../src/box/http.js";
import { Boxes } from "../src/box/manager.js";
import { sha } from "./fixtures.js";

it.effect(
  "box control authenticates before dispatch and validates pinned full templates and safe path identifiers",
  () =>
    Effect.gen(function* boundary() {
      const calls = yield* Ref.make<string[]>([]);

      const boxes = Boxes.of({
        act: (input) =>
          Ref.update(calls, (values) => [...values, input.action]).pipe(
            Effect.as({ state: "idle" })
          ),
        create: (input) =>
          Ref.update(calls, (values) => [...values, "create"]).pipe(
            Effect.as({ peonId: input.peonId, state: "idle" })
          ),
        inspect: () =>
          Ref.update(calls, (values) => [...values, "inspect"]).pipe(
            Effect.as({ processes: 0, state: "suspended" })
          ),
      });

      yield* HttpRouter.serve(boxRoutes(Redacted.make("box-secret")), {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.provide(Layer.succeed(Boxes, boxes)), Layer.build);

      const template = {
        limits: { cpus: 2, memory: "4g", pids: 512 },
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
        (yield* HttpClient.get("/v1/boxes/peon", { headers })).status
      ).toBe(200);
      expect(
        (yield* HttpClient.post("/v1/boxes/peon/prompt", {
          body: HttpBody.jsonUnsafe({ requestId: "turn", text: "task" }),
          headers,
        })).status
      ).toBe(200);
      expect(
        (yield* HttpClient.del("/v1/boxes/peon", {
          body: HttpBody.jsonUnsafe({ requestId: "destroy" }),
          headers,
        })).status
      ).toBe(200);
      expect(yield* Ref.get(calls)).toEqual([
        "create",
        "inspect",
        "prompt",
        "destroy",
      ]);
    }).pipe(
      Effect.scoped,
      Effect.provide(NodeHttpServer.layerTest),
      Effect.provideService(Tracer.DisablePropagation, true)
    )
);
