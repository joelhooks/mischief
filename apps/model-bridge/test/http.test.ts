import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Logger, Redacted } from "effect";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import { BridgeFailure } from "../src/bridge-failure.js";
import { Bridge } from "../src/bridge.js";
import { bridgeRoutes } from "../src/http.js";
import { PiProcess } from "../src/pi-process.js";
import { completion, request } from "./fixtures.js";

const post = (body: typeof request, authorization: string) =>
  HttpClient.post("/v1/responses", {
    body: HttpBody.jsonUnsafe(body),
    headers: { authorization },
  });

it.effect(
  "the HTTP seam authenticates before starting Pi, returns typed failures and never logs prompts",
  () =>
    Effect.gen(function* httpSeam() {
      const logs: string[] = [];

      const logger = Logger.make(({ message }) => {
        logs.push(JSON.stringify(message));
      });

      let starts = 0;

      const process = PiProcess.of({
        run: (input) => {
          starts += 1;

          return input.instructions === "fail"
            ? Effect.fail(
                new BridgeFailure({
                  message: "upstream failed",
                  retryAfter: 60,
                  status: 429,
                })
              )
            : Effect.succeed(completion);
        },
      });

      const key = Redacted.make("test-bearer-secret");
      yield* HttpRouter.serve(bridgeRoutes(key), {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(
        Layer.provide(
          Bridge.layer.pipe(Layer.provide(Layer.succeed(PiProcess, process)))
        ),
        Layer.provide(Logger.layer([logger])),
        Layer.build
      );
      const noAuth = yield* post(request, "Bearer wrong");
      expect(noAuth.status).toBe(401);
      expect(starts).toBe(0);

      const invalid = yield* HttpClient.post("/v1/responses", {
        body: HttpBody.jsonUnsafe({
          ...request,
          tools: [],
          unknownSecret: "must never log",
        }),
        headers: { authorization: "Bearer test-bearer-secret" },
      });

      expect(invalid.status).toBe(400);
      expect(yield* invalid.text).toContain("tools");
      expect(starts).toBe(0);
      const success = yield* post(request, "Bearer test-bearer-secret");
      expect(success.status).toBe(200);
      expect(yield* success.text).toContain("response.completed");

      const error = yield* post(
        { ...request, instructions: "fail" },
        "Bearer test-bearer-secret"
      );

      expect(error.status).toBe(429);
      expect(error.headers["retry-after"]).toBe("60");
      expect(starts).toBe(2);
      const health = yield* HttpClient.get("/healthz");
      expect(yield* health.json).toMatchObject({
        inFlight: 0,
        version: "0.1.0",
      });
      expect(logs.length).toBeGreaterThan(0);
      const logged = logs.join("\n");
      expect(logged).not.toContain("private review prompt");
      expect(logged).not.toContain("test-bearer-secret");
      expect(logged).not.toContain("must never log");
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest))
);
