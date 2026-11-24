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
  const inventoriesRead = new Set<string>();

  const runner = Runner.of({
    run: Effect.fnUntraced(function* parkedBoxCommand({ executable, args }) {
      if (executable === "id" && args.length === 1 && args[0] === "-u") {
        return { exit: 0, stdout: "1000\n" };
      }

      const invocation = args.join(" ");

      if (
        executable === "docker" &&
        ["mischief-peon-boxes", "mischief-peon-browser"].some(
          (network) =>
            invocation ===
            `network inspect --format {{json .Containers}} ${network}`
        ) &&
        !inventoriesRead.has(invocation)
      ) {
        inventoriesRead.add(invocation);

        return { exit: 0, stdout: "{}" };
      }

      return yield* Effect.die(
        `Reading a parked session must not invoke ${executable}`
      );
    }),
  });

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
                  Layer.succeed(Runner, runner)
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
  "a suspended box serves bounded summaries of its 10 MiB session without invoking Docker after startup",
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

const openAiFixturePrefix = ["sk", "-"].join("");

const pemFixtureLabel = ["PRIVATE", "KEY"].join(" ");

const previewSecrets = {
  bearer: "fake-short-bearer",
  auth: "fake-basic-auth",
  openAi: `${openAiFixturePrefix}${"s".repeat(24)}`,
  githubPersonal: ["gh", "p_", "a".repeat(36)].join(""),
  githubOAuth: ["gh", "o_", "b".repeat(36)].join(""),
  githubInstall: ["gh", "s_", "c".repeat(36)].join(""),
  githubFineGrained: ["github", "pat", "s".repeat(82)].join("_"),
  aws: ["AK", "IA", "X".repeat(16)].join(""),
  pem: "synthetic-pem-row",
  modelRoute: "mischief-model-route-example-fixture-42",
  labelledRoute: "synthetic-short-fixture",
  hex: "e2".repeat(20),
  base64: "Ab93+_".repeat(8),
};

const previewPayload = [
  `Bearer ${previewSecrets.bearer}`,
  `Authorization: Basic ${previewSecrets.auth}`,
  previewSecrets.openAi.replace(
    openAiFixturePrefix,
    `${openAiFixturePrefix}\u001B[31m`
  ),
  previewSecrets.githubPersonal,
  previewSecrets.githubOAuth,
  previewSecrets.githubInstall,
  previewSecrets.githubFineGrained,
  previewSecrets.aws,
  `-----BEGIN ${pemFixtureLabel}-----\n${previewSecrets.pem}\n-----END ${pemFixtureLabel}-----`,
  previewSecrets.modelRoute,
  `MISCHIEF_MODEL_ROUTE_KEY=${previewSecrets.labelledRoute}`,
  previewSecrets.hex,
  previewSecrets.base64,
  "\u001B]52;c;clipboard-fixture\u0007",
  "\u009D8;;https://hidden.invalid\u009Clink label\u001B]8;;\u001B\\",
  "\u001B[\u001B]52;c;nested-clipboard\u0007",
  "\u001BPprivate-dcs\u001B\\\u001B[12;4Hplain\u0000\u0080\ttext",
].join("\n");

const previewRecord = (role: "user" | "assistant", content: Schema.Json) =>
  JSON.stringify({ type: "message", message: { role, content } });

it.effect("tail strips invisible controls before redacting whole secrets", () =>
  Effect.gen(function* invisibleControlsAndJwt() {
    const { fs, home, tail } = yield* runRoute();

    const invisibleControls =
      "\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069\u200B\u200C\u200D\u200E\u200F\uFEFF\u2060\u2061\u2062\u2063\u2064\u00AD\u061C\u180E";

    const markedText = Array.from(
      invisibleControls,
      (mark) => `a${mark}b`
    ).join(" ");

    const splitSecret = ["s", "\u200B", "k-", "a".repeat(24)].join("");
    const joinedSecret = ["s", "\u2060", "k-", "b".repeat(24)].join("");
    const jwtHeader = ["ey", "J", "hbGciOiJIUzI1NiJ9"].join("");
    const jwt = [jwtHeader, "e30", "fake-signature"].join(".");
    const unsignedJwt = [jwtHeader, "e30", ""].join(".");

    const assistant = previewRecord("assistant", [
      {
        type: "text",
        text: `${markedText} a\u2065b\n${splitSecret} ${joinedSecret} ${jwt} ${unsignedJwt} done`,
      },
      {
        type: "toolCall",
        name: "bash",
        arguments: { command: `check ${jwt}` },
      },
    ]);

    yield* fs.writeFileString(`${home}/session.jsonl`, `${assistant}\n`);

    const { result } = yield* readPage(yield* tail({}));

    expect(result).toMatchObject({
      status: "tail",
      entries: [
        {
          text: `${Array.from(invisibleControls, () => "ab").join(" ")} a\u2065b\n[redacted] [redacted] [redacted] [redacted] done`,
          toolCalls: [{ name: "bash", args: '{"command":"check [redacted]"}' }],
        },
      ],
    });
  }).pipe(Effect.provide(NodeServices.layer))
);

const verboseAssistant = previewRecord("assistant", [
  { type: "text", text: "work 🛠 ".repeat(400) },
]);

it.effect(
  "tail shows redacted conversation and tool previews but never private metadata",
  () =>
    Effect.gen(function* preview() {
      const { fs, home, tail } = yield* runRoute();
      const user = previewRecord("user", `Please verify.\n${previewPayload}`);

      const assistant = previewRecord("assistant", [
        { type: "text", text: `Checking the build.\n${previewPayload}` },
        { type: "thinking", thinking: "private-chain" },
        {
          type: "toolCall",
          name: "bash\u001B[31m",
          arguments: {
            command: `pnpm check\n${previewPayload}`,
            extra: "🛠 ".repeat(300),
            metadata: { note: "arg-metadata-fixture" },
          },
        },
      ]);

      const protectedRecord = JSON.stringify({
        type: "message",
        message: { role: "assistant", content: "hidden-env-message" },
        details: { env: { PATH: "hidden-env-value" } },
      });

      const system = JSON.stringify({
        type: "message",
        message: { role: "system", content: "hidden-system-prompt" },
      });

      const model = JSON.stringify({
        type: "model_change",
        modelId: "hidden-model-id",
      });

      yield* fs.writeFileString(
        `${home}/session.jsonl`,
        `${[user, assistant, protectedRecord, system, model].join("\n")}\n`
      );

      const { body, result } = yield* readPage(yield* tail({}));
      expect(result.status).toBe("tail");

      if (result.status !== "tail") {
        return;
      }

      const [
        userEntry,
        assistantEntry,
        protectedEntry,
        systemEntry,
        modelEntry,
      ] = result.entries;

      expect(userEntry?.text).toContain("Please verify.\n[redacted]");
      expect(assistantEntry?.text).toContain("Checking the build.\n[redacted]");
      expect(assistantEntry?.text).toContain("link label");
      expect(assistantEntry?.text).toContain("plain\ttext");
      const call = assistantEntry?.toolCalls?.[0];
      const args = call?.args ?? "";

      expect(call?.name).toBe("bash");
      expect(args).toContain("pnpm check\\n[redacted]");
      expect(args.endsWith("…")).toBe(true);
      expect(Buffer.byteLength(args)).toBeLessThanOrEqual(512);
      expect(args.split("[redacted]")).toHaveLength(
        Object.keys(previewSecrets).length + 1
      );
      expect(assistantEntry?.text?.split("[redacted]")).toHaveLength(
        Object.keys(previewSecrets).length + 1
      );
      expect(protectedEntry).toMatchObject({
        type: "assistant",
        bytes: Buffer.byteLength(protectedRecord),
      });
      expect(protectedEntry?.text).toBeUndefined();
      expect(systemEntry?.type).toBe("system");
      expect(modelEntry?.type).toBe("model_change");

      for (const forbidden of [
        ...Object.values(previewSecrets),
        "clipboard-fixture",
        "hidden.invalid",
        "nested-clipboard",
        "private-dcs",
        "arg-metadata-fixture",
        "private-chain",
        "hidden-env-",
        "hidden-system-prompt",
        "hidden-model-id",
        "\\u001b",
        "\\u009d",
      ]) {
        expect(body).not.toContain(forbidden);
      }
    }).pipe(Effect.provide(NodeServices.layer))
);

it.effect(
  "text previews fit the entry and page wire budgets without splitting UTF-8",
  () =>
    Effect.gen(function* textBudgets() {
      const { fs, home, tail } = yield* runRoute();
      yield* fs.writeFileString(
        `${home}/session.jsonl`,
        `${verboseAssistant}\n`.repeat(100)
      );

      const { body, result } = yield* readPage(yield* tail({ entries: 100 }));
      expect(result.status).toBe("tail");

      if (result.status !== "tail") {
        return;
      }

      expect(result.truncated).toBe(true);
      expect(result.entries.length).toBeGreaterThan(1);
      expect(result.entries.length).toBeLessThan(100);
      expect(Buffer.byteLength(body)).toBeLessThan(64 * 1024);

      for (const entry of result.entries) {
        expect(entry.text).toMatch(/^work 🛠 .*…$/u);
        expect(entry.text).not.toContain("�");
        expect(Buffer.byteLength(JSON.stringify(entry))).toBeLessThanOrEqual(
          2048
        );
      }
    }).pipe(Effect.provide(NodeServices.layer))
);

it.effect(
  "tail refuses a symlinked box home without reading the target session",
  () =>
    Effect.gen(function* symlinkedHome() {
      const { fs, home, mount, tail } = yield* runRoute();
      const target = `${mount}/other-home`;
      const targetText = "Text from the unowned session";
      yield* fs.rename(home, target);
      yield* fs.writeFileString(
        `${target}/session.jsonl`,
        `${previewRecord("user", targetText)}\n`
      );
      yield* fs.symlink(target, home);

      const response = yield* tail({});
      expect(response.status).toBe(503);
      expect(yield* Effect.promise(response.text.bind(response))).not.toContain(
        targetText
      );
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
