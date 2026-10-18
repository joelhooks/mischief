// @effect-diagnostics nodeBuiltinImport:off asyncFunction:off -- This child measures its own forced-GC heap against SQLite and feeds an async fake-fetch stream to pi-ai.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, watchEvents } from "@earendil-works/pi-durable";
import { Thinker } from "@mischief/core";
import { Effect, Redacted, Schema } from "effect";

import { gatewayThinkerOptions, piThinker } from "../dist/index.js";
import { nodeSqliteStorageFor } from "../dist/node-storage.js";

const config = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      chunks: Schema.Int,
      held: Schema.Boolean,
      width: Schema.Int,
    })
  )
)(process.argv[2]);

const dir = mkdtempSync(path.join(tmpdir(), "mischief-stream-heap-property-"));

const heaps: number[] = [];

const { gc } = globalThis;

if (gc === undefined) {
  throw new Error("heap measurement requires node --expose-gc");
}

const sample = () => {
  gc();
  heaps.push(process.memoryUsage().heapUsed);
};

const open = Harness.open.bind(Harness);

Harness.open = async (storage, options, context) => {
  const harness = await open(
    storage,
    {
      ...options,
      settings: { ...options.settings, progress: { partialIntervalMs: 0 } },
    },
    context
  );

  if (config.held) {
    const conversation = harness.conversation.bind(harness);

    harness.conversation = async (...args) => {
      const current = await conversation(...args);

      if (current !== undefined) {
        const stream = await watchEvents(
          harness,
          current.id,
          BACKGROUND_CONTEXT
        );

        stream.start(async () => {
          await Promise.resolve();
        });
      }

      return current;
    };
  }

  return harness;
};

const deltaAt = (index: number) => String(index % 10).repeat(config.width);

const output = Array.from({ length: config.chunks }, (_, index) =>
  deltaAt(index)
).join("");

const send = (
  controller: ReadableStreamDefaultController<Uint8Array>,
  event: Schema.Json & { readonly type: string }
) => {
  controller.enqueue(
    new TextEncoder().encode(
      `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
    )
  );
};

const fetch = async () =>
  await Promise.resolve(
    new Response(
      new ReadableStream({
        start: async (controller) => {
          sample();
          send(controller, {
            response: { id: "heap-response" },
            type: "response.created",
          });
          send(controller, {
            item: { content: [], id: "heap-message", type: "message" },
            output_index: 0,
            type: "response.output_item.added",
          });

          for (let index = 0; index < config.chunks; index += 1) {
            send(controller, {
              delta: deltaAt(index),
              output_index: 0,
              type: "response.output_text.delta",
            });
            // oxlint-disable-next-line no-await-in-loop -- Each delay permits a partial commit before the next generated delta.
            await delay(2);

            if ((index + 1) % 100 === 0) {
              sample();
            }
          }

          await delay(10);
          sample();
          send(controller, {
            item: {
              content: [{ text: output, type: "output_text" }],
              id: "heap-message",
              type: "message",
            },
            output_index: 0,
            type: "response.output_item.done",
          });
          send(controller, {
            response: {
              id: "heap-response",
              status: "completed",
              usage: {
                input_tokens: 85_000,
                output_tokens: output.length / 4,
                total_tokens: 85_000 + output.length / 4,
              },
            },
            type: "response.completed",
          });
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" }, status: 200 }
    )
  );

await Effect.runPromise(
  Effect.gen(function* measure() {
    const thinker = yield* Thinker;

    const result = yield* thinker.think({
      agent: { model: "luna", thinking: "max" },
      ceiling: "max",
      epoch: 0,
      key: "think",
      prompt: "input ".repeat(57_000),
      runId: "heap",
      visit: 1,
    });

    sample();

    const [baseline] = heaps;

    if (baseline === undefined) {
      throw new Error("stream did not emit a heap baseline");
    }

    process.stdout.write(
      `RESULT ${JSON.stringify({
        exact: result.output === output,
        growth: Math.max(...heaps) - baseline,
        heaps,
        receipt: result.receipt,
        tokens: result.tokens,
      })}\n`
    );
  }).pipe(
    Effect.provide(
      piThinker(
        gatewayThinkerOptions(nodeSqliteStorageFor(dir), {
          apiKey: Redacted.make("heap-test-key"),
          baseUrl: "https://heap.test/v1",
          fetch,
        })
      )
    )
  )
);
