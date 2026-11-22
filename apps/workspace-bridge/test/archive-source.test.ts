import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";

import { collectArchive, sha256 } from "../src/box/archive-source.js";
import type { BoxMetadata } from "../src/box/protocol.js";
import { boxRunnerLayer } from "../src/box/runner.js";
import { image, sha } from "./fixtures.js";

const piId = "ba64196f-b704-4d1a-a45b-161a1695ae9c";

const claudeId = "8bef6a17-e343-4849-9858-aa31eafe62af";

const box: BoxMetadata = {
  image,
  lastPromptAt: 1,
  peonId: "fixture",
  state: "suspended",
  template: {
    limits: { cpus: 1, memory: "1g", pids: 10, tmp: "1g" },
    model: "sol",
    thinking: "off",
    tools: "all",
    workspace: { repo: "example/review", sha },
  },
};

const fixture = Effect.gen(function* makeFixture() {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped();
  const pi = `${home}/.pi/agent/sessions`;
  yield* fs.makeDirectory(pi, { recursive: true });

  const header = JSON.stringify({
    cwd: "/work",
    id: piId,
    timestamp: "2026-01-01T00:00:00Z",
    type: "session",
    version: 3,
  });

  yield* fs.writeFileString(`${home}/session.jsonl`, `${header}\n`);

  return {
    fs,
    home,
    pi,
    scan: (source = home) =>
      collectArchive(source, box, {
        boxId: "container-fixture",
        host: "test-host",
        row: "desk-row",
      }),
  };
});

it.effect(
  "raw bytes survive malformed, empty and unknown-version headers and derive only known session ids",
  () =>
    Effect.gen(function* rawBytes() {
      const { fs, home, pi, scan } = yield* fixture;
      yield* fs.writeFileString(`${pi}/empty.jsonl`, "");
      yield* fs.writeFileString(`${pi}/unknown.jsonl`, '{"version":99}\n');
      yield* fs.writeFile(`${pi}/headerless.jsonl`, Uint8Array.of(255, 10, 31));
      const claude = `${home}/.claude/projects/-work`;
      yield* fs.makeDirectory(claude, { recursive: true });
      yield* fs.writeFileString(
        `${claude}/${claudeId}.jsonl`,
        `{"type":"summary"}\n${JSON.stringify({ sessionId: claudeId })}\n`
      );
      const first = yield* scan();
      expect(first.manifest).toMatchObject({
        box_id: "container-fixture",
        row: "desk-row",
        session_ids: [claudeId, piId],
        source_roots: [
          { path: "session.jsonl", role: "authoritative" },
          { path: ".pi/agent/sessions", role: "authoritative" },
          { path: ".claude/projects", role: "derived" },
        ],
        unparsed: [
          ".pi/agent/sessions/empty.jsonl",
          ".pi/agent/sessions/headerless.jsonl",
          ".pi/agent/sessions/unknown.jsonl",
        ],
      });
      expect(first.files.paths).toHaveLength(5);
      yield* fs.writeFileString(
        `${claude}/${claudeId}.jsonl`,
        "rewritten derived bytes\n"
      );
      const rewritten = yield* scan();
      expect(rewritten.files.fingerprint).not.toBe(first.files.fingerprint);
    }).pipe(Effect.provide(NodeServices.layer))
);

it.effect(
  "a Claude session ID after 64 KiB of the first record is included without truncating its bytes",
  () =>
    Effect.gen(function* longClaudeRecord() {
      const { fs, home, scan } = yield* fixture;
      const path = ".claude/projects/long.jsonl";
      yield* fs.makeDirectory(`${home}/.claude/projects`, { recursive: true });

      const record = JSON.stringify({
        text: "x".repeat(80 * 1024),
        sessionId: claudeId,
      });

      yield* fs.writeFileString(`${home}/${path}`, record);
      const archive = yield* scan();
      expect(archive.manifest.session_ids).toContain(claudeId);
      expect(archive.manifest.unparsed).not.toContain(path);
      expect(archive.files.checksums).toContain(`${sha256(record)}  ${path}\n`);
    }).pipe(Effect.provide(NodeServices.layer))
);

it.effect("authoritative roots refuse noncanonical root components", () =>
  Effect.gen(function* sourceRefusals() {
    const { fs, home, scan } = yield* fixture;
    const outside = yield* fs.makeTempDirectoryScoped();
    yield* fs.symlink(home, `${outside}/home-alias`);
    expect(
      (yield* Effect.flip(scan(`${outside}/home-alias`))).message
    ).toContain("not a canonical directory");
    yield* fs.symlink(outside, `${home}/.codex`);
    expect((yield* Effect.flip(scan())).message).toContain(
      "Session root is not a canonical"
    );
  }).pipe(
    Effect.provide(
      boxRunnerLayer().pipe(Layer.provideMerge(NodeServices.layer))
    )
  )
);
