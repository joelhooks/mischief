import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { BoxTailResult } from "@mischief/core";
import { Context, Effect, FileSystem, Layer, Redacted, Schema } from "effect";
import * as Digest from "effect/crypto/Digest";
import { HttpRouter } from "effect/http";

import { ArchivePort } from "../src/box/archive.js";
import { boxRoutes } from "../src/box/http.js";
import { Boxes } from "../src/box/manager.js";
import { Runner } from "../src/runner.js";
import { image, sha } from "./fixtures.js";

const marker = "mischief-model-route-synthetic-secret-7c6a";

const toolResult = JSON.stringify({
  type: "message",
  id: marker,
  message: {
    role: "toolResult",
    content: [
      {
        type: "text",
        text: `${[
          "\u001B]52;c;clipboard-payload\u0007",
          "\u001B]8;;https://osc-link.invalid\u001B\\label\u001B]8;;\u001B\\",
          "\u001B[12;4HCSI-payload",
          "\u001B]2;window-title\u0007",
          "\u009B10CC1-payload\u0000",
        ].join("")}\nMISCHIEF_MODEL_ROUTE_KEY=${marker}`,
      },
    ],
    headers: { Authorization: `Bearer ${marker}` },
  },
});

const blob = JSON.stringify({
  type: "message",
  message: { role: "assistant", content: "🛠".repeat(768) },
});

const runRoute = Effect.fnUntraced(function* runRoute() {
  const fs = yield* FileSystem.FileSystem;
  const mount = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());

  const config = {
    gid: 1000,
    image,
    metadata: `${mount}/meta`,
    mirrors: {},
    mount,
    root: `${mount}/boxes`,
    snapshots: `${mount}/snapshots`,
  };

  const home = `${config.root}/test-box/home`;
  const meta = `${config.metadata}/test-box`;
  yield* fs.makeDirectory(home, { recursive: true });
  yield* fs.makeDirectory(meta, { recursive: true });

  const recordState = (state: "suspended" | "hibernated") =>
    fs.writeFileString(
      `${meta}/box.json`,
      JSON.stringify({
        state,
        image,
        lastPromptAt: null,
        peonId: "test-box",
        template: {
          limits: { cpus: 2, memory: "4g", pids: 512, tmp: "1g" },
          model: "opus",
          thinking: "medium",
          tools: "all",
          workspace: { repo: "example/review", sha },
        },
      })
    );

  yield* recordState("suspended");

  const handler = yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        boxRoutes(Redacted.make("fake-box-key")).pipe(
          Layer.provideMerge(
            Boxes.layer(config).pipe(
              Layer.provide(
                Layer.mergeAll(
                  ArchivePort.disabled,
                  NodeServices.layer,
                  Digest.layerWebCrypto,
                  Layer.succeed(
                    Runner,
                    Runner.of({
                      run: ({ executable, args }) =>
                        executable === "id" &&
                        args.length === 1 &&
                        args[0] === "-u"
                          ? Effect.succeed({ exit: 0, stdout: "1000\n" })
                          : Effect.die(
                              `Reading a parked session must not invoke ${executable}`
                            ),
                    })
                  )
                )
              )
            )
          )
        ),
        { disableLogger: true }
      )
    ),
    ({ dispose }) => Effect.promise(dispose)
  );

  const tail = (body: Schema.Json, id = "test-box") =>
    Effect.promise(
      handler.handler.bind(
        undefined,
        new Request(`http://box.invalid/v1/boxes/${id}/tail`, {
          body: JSON.stringify(body),
          headers: {
            authorization: "Bearer fake-box-key",
            "content-type": "application/json",
          },
          method: "POST",
        }),
        Context.empty()
      )
    );

  return { fs, home, mount, recordState, tail };
});

const readPage = Effect.fnUntraced(function* readPage(response: Response) {
  expect(response.status).toBe(200);
  const body = yield* Effect.promise(response.text.bind(response));

  const result = yield* Schema.decodeEffect(
    Schema.fromJsonString(BoxTailResult)
  )(body);

  return { body, result };
});

it.effect(
  "a suspended box serves bounded summaries of its 10 MiB session without starting any process",
  () =>
    Effect.gen(function* boundedTail() {
      const { fs, home, tail } = yield* runRoute();
      const session = `${home}/session.jsonl`;
      const filler = `${blob}\n`;
      const content = `${filler.repeat(Math.ceil((10 * 1024 * 1024) / Buffer.byteLength(filler)))}${toolResult}\n`;
      yield* fs.writeFileString(session, content);

      const { body, result } = yield* readPage(yield* tail({ entries: 200 }));
      expect(result.status).toBe("tail");

      if (result.status !== "tail") {
        return;
      }

      expect(result.entries).toHaveLength(200);
      expect(result.truncated).toBe(true);
      expect(result.entries.at(-2)).toMatchObject({
        type: "blob",
        bytes: Buffer.byteLength(blob),
      });
      expect(result.entries.at(-1)).toMatchObject({
        type: "toolResult",
        bytes: Buffer.byteLength(toolResult),
      });
      expect(Buffer.byteLength(body)).toBeLessThan(64 * 1024);

      for (const entry of result.entries) {
        expect(Buffer.byteLength(JSON.stringify(entry))).toBeLessThan(2048);
      }

      for (const forbidden of [
        marker,
        "MISCHIEF_MODEL_ROUTE_KEY",
        "Authorization",
        "clipboard-payload",
        "osc-link.invalid",
        "CSI-payload",
        "window-title",
        "C1-payload",
        "\\u001b",
        "\\u009b",
      ]) {
        expect(body).not.toContain(forbidden);
      }

      const cursor = result.entries.at(-1)?.id;
      expect(cursor).toBeDefined();

      if (cursor === undefined) {
        return;
      }

      const nextLine = '{"type":"message","message":{"role":"assistant"}}';
      yield* fs.writeFileString(
        session,
        `${content}${nextLine}\n{"type":"message"`
      );
      const next = yield* readPage(yield* tail({ sinceId: cursor }));
      expect(next.result).toEqual({
        entries: [
          {
            type: "assistant",
            bytes: Buffer.byteLength(nextLine),
            id: `b${Buffer.byteLength(content + nextLine) + 1}`,
          },
        ],
        status: "tail",
        truncated: false,
      });

      const defaults = yield* readPage(yield* tail({}));
      expect(defaults.result.status).toBe("tail");

      if (defaults.result.status === "tail") {
        expect(defaults.result.entries).toHaveLength(30);
      }
    }).pipe(Effect.provide(NodeServices.layer))
);

it.effect(
  "tail refuses caller paths and symlinked session files and never extracts a hibernated snapshot",
  () =>
    Effect.gen(function* confinedTail() {
      const { fs, home, mount, recordState, tail } = yield* runRoute();
      yield* fs.writeFileString(`${mount}/other.jsonl`, `${toolResult}\n`);
      yield* fs.symlink(`${mount}/other.jsonl`, `${home}/session.jsonl`);

      expect((yield* tail({ path: "../../other.jsonl" })).status).toBe(400);
      expect((yield* tail({}, "..%2fother")).status).toBe(404);
      const link = yield* tail({});
      expect(link.status).toBe(503);
      expect(yield* Effect.promise(link.text.bind(link))).not.toContain(marker);

      yield* recordState("hibernated");
      expect((yield* readPage(yield* tail({}))).result).toEqual({
        reason: "hibernated",
        status: "not-live",
      });
    }).pipe(Effect.provide(NodeServices.layer))
);
