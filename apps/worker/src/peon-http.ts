// @effect-diagnostics asyncFunction:off -- Durable Object stubs expose Promise APIs to the HTTP composition root.
import { toHttpApi } from "@mischief/capability/http-api";
import {
  mergePeonTemplate,
  peonCapabilities,
  peonTemplateReference,
  Peons,
  PeonRefused,
  PeonTombstone,
} from "@mischief/core";
import type { PeonIndexEntry } from "@mischief/core";
import { Clock, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";

import { freshPeonId as freshId, hashPeonText } from "./peon-crypto.js";
import { peonGranted } from "./peon-grants.js";
import { assertPeonSpawnable } from "./peon-host.js";
import { peonRpc } from "./peon-object.js";
import { PEON_REGISTRY } from "./peon-state.js";
import type { Env } from "./plan-run-object.js";

export const peonServices = (env: Env, owner: string): Peons["Service"] => {
  const registry = () => env.PEON_TEMPLATES.getByName(PEON_REGISTRY);

  const entryFor = Effect.fn("Peon.entryFor")(function* entryFor(id: string) {
    const entry = yield* peonRpc(async () => await registry().lookup(id));

    if (entry === null || entry.owner !== owner) {
      return yield* new PeonRefused({
        reason: `Unknown peon ${id} for this caller; returning a foreign workspace would expose private work. Call listPeons, or spawnPeon with a fresh id.`,
      });
    }

    return entry;
  });

  const owned = Effect.fn("Peon.owned")(function* owned(id: string) {
    const entry = yield* entryFor(id);

    if (entry.state === "destroyed") {
      return yield* new PeonRefused({
        reason: `Peon ${id} was destroyed at ${entry.destroyedAt}; its tombstone names template ${entry.template.name}@${entry.template.version}. Call spawnPeon with a new id; destroyed ids cannot be reused.`,
      });
    }

    return env.PEON.getByName(id);
  });

  const command = Effect.fn("Peon.command")(function* command(
    kind: "prompt" | "suspend" | "resume" | "hibernate" | "destroy",
    input: {
      readonly peonId: string;
      readonly requestId?: string;
      readonly text?: string;
    }
  ) {
    const object = yield* owned(input.peonId);
    const requestId = input.requestId ?? (yield* freshId);

    return yield* peonRpc(
      async () =>
        await object.command(kind, requestId, input.text, undefined, owner)
    );
  });

  return Peons.of({
    clonePeon: (input) =>
      Effect.gen(function* clone() {
        const object = yield* owned(input.peonId);
        const requestId = input.requestId ?? (yield* freshId);

        const hash = yield* hashPeonText(
          JSON.stringify([owner, input.peonId, requestId])
        );

        const newPeonId = input.newPeonId ?? `clone-${hash.slice(0, 32)}`;

        if (newPeonId === input.peonId) {
          return yield* new PeonRefused({
            reason: `Peon ${input.peonId} cannot clone into its own id; copying over it would corrupt its workspace. Retry clonePeon with a different newPeonId.`,
          });
        }

        return yield* peonRpc(
          async () =>
            await object.command("clone", requestId, undefined, newPeonId)
        );
      }),
    destroyPeon: (input) =>
      Effect.gen(function* destroy() {
        const entry = yield* entryFor(input.peonId);

        if (entry.state === "destroyed") {
          return yield* Schema.decodeUnknownEffect(PeonTombstone)(entry).pipe(
            Effect.orDie
          );
        }

        return yield* command("destroy", input);
      }),
    hibernatePeon: (input) => command("hibernate", input),
    inspectPeon: ({ peonId }) =>
      Effect.gen(function* inspect() {
        const entry = yield* entryFor(peonId);

        if (entry.state === "destroyed") {
          return yield* Schema.decodeUnknownEffect(PeonTombstone)(entry).pipe(
            Effect.orDie
          );
        }

        return yield* peonRpc(
          async () => await env.PEON.getByName(peonId).inspect()
        );
      }),
    listPeonTemplates: (input) =>
      peonRpc(async () => await registry().templates(input)),
    listPeons: (input) =>
      peonRpc(async () => await registry().list(input, owner)),
    promptPeon: (input) => command("prompt", input),
    resumePeon: (input) => command("resume", input),
    savePeonTemplate: (input) =>
      peonRpc(async () => await registry().save(input)),
    spawnPeon: (input) =>
      Effect.gen(function* spawn() {
        const version = yield* peonRpc(
          async () =>
            await registry().resolve(peonTemplateReference(input.template))
        );

        const template = yield* mergePeonTemplate(
          version.template,
          input.overrides ?? {}
        );

        yield* assertPeonSpawnable(template);

        const peonId = input.peonId ?? (yield* freshId);

        const now = yield* Clock.currentTimeMillis;

        const entry: typeof PeonIndexEntry.Type = {
          creationKey: `spawn/${peonId}`,
          owner,
          peonId,
          state: "spawned",
          template: { name: version.name, version: version.version },
          updatedAt: now,
        };

        yield* peonRpc(async () => await registry().claim(entry));

        return yield* peonRpc(
          async () =>
            await env.PEON.getByName(peonId).initialize(entry, template)
        );
      }),
    suspendPeon: (input) => command("suspend", input),
  });
};

const http = toHttpApi("Mischief peons", peonCapabilities);

export const peonHttp = (env: Env, owner: string) =>
  HttpRouter.toWebHandler(
    HttpApiBuilder.layer(http.api).pipe(
      Layer.provide(http.layer),
      Layer.provide(
        Layer.merge(
          Layer.succeed(Peons, peonServices(env, owner)),
          HttpServer.layerServices
        )
      )
    ),
    { disableLogger: true }
  );

export const servePeon = async (
  request: Request,
  env: Env,
  owner: string,
  capability: string
) => {
  if (
    env.MISCHIEF_PEON_BOXES !== "on" ||
    (env.MISCHIEF_BOX_URL ?? "") === "" ||
    (env.MISCHIEF_BOX_KEY ?? "") === ""
  ) {
    return Response.json(
      {
        error:
          "Peon boxes are off or unwired; starting a box would bypass host authorization. Ask the desk to set MISCHIEF_PEON_BOXES=on, MISCHIEF_BOX_URL and MISCHIEF_BOX_KEY, then retry spawnPeon.",
      },
      { status: 503 }
    );
  }

  if (!peonGranted(env.MISCHIEF_PEON_GRANTS, owner, capability)) {
    return Response.json(
      {
        error: `Caller ${owner} has no ${capability} grant; full-tool boxes can write workspaces. Ask the desk to add this capability to mischief.peonCapabilities in callers.json, then retry.`,
      },
      { status: 403 }
    );
  }

  const { handler, dispose } = peonHttp(env, owner);

  try {
    return await handler(request);
  } finally {
    await dispose();
  }
};
