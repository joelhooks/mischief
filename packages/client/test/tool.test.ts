import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { RunReportSchema, validatePlan } from "@mischief/core";
import type { RunReport } from "@mischief/core";
import { Effect, Layer, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { HttpClient, HttpClientResponse } from "effect/http";

import { makeClient } from "../src/client.js";
import { firstPlan } from "../src/first-plan.js";
import { executeRequest } from "../src/tool.js";
import { freshIdentity } from "./identity-fixture.js";

const reportLayer = (report: RunReport) =>
  Layer.merge(
    Layer.merge(NodeServices.layer, SecureRandom.layerWebCrypto),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(request, Response.json(report))
        )
      )
    )
  );

it.effect(
  "the desk-run proof's no-mail plan validates against the shipped grammar",
  () =>
    Effect.gen(function* validateProofPlan() {
      const plan = yield* validatePlan(firstPlan);

      expect(plan.envelope.names).toEqual([]);
    })
);

it.effect.prop(
  "the tool names the host's run and state, preserves its receipt, and offers an inspect call on the same named host",
  { report: Arbitrary.schema(RunReportSchema) },
  ({ report }) =>
    Effect.gen(function* renderReport() {
      const client = yield* makeClient(
        {
          audience: "did:web:host.example.invalid#mischief",
          endpoint: "https://mischief.example.invalid",
        },
        yield* freshIdentity()
      );

      const result = yield* executeRequest(client, {
        host: "named-host",
        request: { action: "inspect", runId: report.runId },
      });

      expect(result.content[0]?.text).toContain(
        `${report.runId} · ${report.status}`
      );
      expect(result.content[0]?.text).toContain(
        JSON.stringify({
          host: "named-host",
          request: { action: "inspect", runId: report.runId },
        })
      );

      const wireReport = yield* Schema.decodeEffect(
        Schema.fromJsonString(Schema.Json)
      )(JSON.stringify(report));

      expect(result.details).toEqual(wireReport);
    }).pipe(Effect.provide(reportLayer(report)))
);
