import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Crypto, Effect, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/http";

import { ClientError } from "./client-error.js";
import { firstPlan } from "./first-plan.js";
import { projectClient } from "./project.js";

const proof = Effect.gen(function* liveProof() {
  const [host] = yield* Schema.decodeUnknownEffect(
    Schema.Tuple([Schema.String])
  )(process.argv.slice(2)).pipe(
    Effect.mapError(
      () =>
        new ClientError({
          kind: "input",
          operation: "live-proof",
          reason:
            "Expected exactly one configured host name. Run node packages/client/dist/live-proof.js <host>. Credentials come from the caller's existing Rat King identity, never argv.",
        })
    )
  );

  const client = yield* projectClient(process.cwd(), host);
  const cryptography = yield* Crypto.Crypto;
  const runId = `client-proof-${yield* cryptography.randomUUIDv4()}`;

  yield* Effect.acquireUseRelease(
    client.submitPlan({ plan: firstPlan, runId }),
    (submitted) =>
      Effect.gen(function* inspectProof() {
        yield* Console.log(`${submitted.runId} · ${submitted.status}`);
        const inspected = yield* client.inspectRun({ runId });

        yield* Console.log(`${inspected.runId} · ${inspected.status}`);
        yield* Console.log(JSON.stringify(yield* client.readRun({ runId })));
      }),
    () =>
      client
        .abortRun({ reason: "Packaged client live proof complete", runId })
        .pipe(
          Effect.tap((aborted) =>
            Console.log(`${aborted.runId} · ${aborted.status}`)
          ),
          Effect.orDie
        )
  );
});

NodeRuntime.runMain(
  proof.pipe(
    Effect.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer))
  )
);
