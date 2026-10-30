import { NodeCrypto, NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Redacted, Ref } from "effect";
import type { Schema } from "effect";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";
import { TestClock } from "effect/testing";

import { Bridge, DOWNTIME_START, DOWNTIME_END } from "../src/bridge.js";
import { bridgeRoutes } from "../src/http.js";
import { refusal } from "../src/protocol.js";
import { Sandbox } from "../src/sandbox.js";
import { completion, request } from "./fixtures.js";

const post = (body: Schema.Json, authorization = "Bearer workspace-key") =>
  HttpClient.post("/v1/responses", {
    body: HttpBody.jsonUnsafe(body),
    headers: { authorization },
  });

it.effect(
  "the bridge authenticates before admission, returns reasoned refusals, and preserves the Responses stream and load contract",
  () =>
    Effect.gen(function* seam() {
      const calls = yield* Ref.make(0);

      const bridge = Bridge.of({
        inFlight: Effect.succeed(0),
        run: (input) =>
          Ref.update(calls, (count) => count + 1).pipe(
            Effect.andThen(
              input.instructions === "busy"
                ? Effect.fail(
                    refusal(
                      "Eight workspaces are busy. Retry this think later.",
                      503
                    )
                  )
                : Effect.succeed(completion)
            )
          ),
      });

      yield* HttpRouter.serve(bridgeRoutes(Redacted.make("workspace-key")), {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(
        Layer.provide(Layer.succeed(Bridge, bridge)),
        Layer.provide(NodeCrypto.layer),
        Layer.build
      );
      expect((yield* post(request, "Bearer wrong")).status).toBe(401);
      expect(yield* Ref.get(calls)).toBe(0);
      expect(
        (yield* post({
          ...request,
          workspace: { ...request.workspace, sha: "main" },
        })).status
      ).toBe(400);
      const wrongModel = yield* post({ ...request, model: "gpt-6.1-sol" });
      expect(wrongModel.status).toBe(400);
      expect(yield* wrongModel.text).toContain("Opus");
      expect(yield* Ref.get(calls)).toBe(0);
      const busy = yield* post({ ...request, instructions: "busy" });
      expect(busy.status).toBe(503);
      expect(yield* busy.text).toContain("Retry");
      const success = yield* post(request);
      expect(success.status).toBe(200);
      expect(yield* success.text).toContain("response.completed");
      expect(yield* (yield* HttpClient.get("/healthz")).json).toEqual({
        queued: 0,
        running: 0,
        version: "0.1.0",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest))
);

it.effect(
  "scheduled downtime is unavailable rather than queued and ends exactly at the published end",
  () =>
    Effect.gen(function* downtime() {
      const calls = yield* Ref.make(0);

      const sandbox = Sandbox.of({
        run: () =>
          Ref.update(calls, (count) => count + 1).pipe(Effect.as(completion)),
        sweep: Effect.void,
      });

      yield* Effect.gen(function* service() {
        const bridge = yield* Bridge;
        yield* TestClock.setTime(DOWNTIME_START);
        expect((yield* Effect.flip(bridge.run(request))).status).toBe(503);
        yield* TestClock.setTime(DOWNTIME_END - 1);
        expect((yield* Effect.flip(bridge.run(request))).status).toBe(503);
        expect(yield* Ref.get(calls)).toBe(0);
        expect(yield* bridge.inFlight).toBe(0);
        yield* TestClock.setTime(DOWNTIME_END);
        expect((yield* bridge.run(request)).text).toBe("verdict");
        expect(yield* Ref.get(calls)).toBe(1);
      }).pipe(
        Effect.provide(Bridge.layer),
        Effect.provideService(Sandbox, sandbox)
      );
    })
);
