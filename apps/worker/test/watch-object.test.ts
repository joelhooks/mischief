import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { armWatchContract, WatchInspection } from "@mischief/core";
import { Effect, Layer, Schedule, Schema } from "effect";
import { FetchHttpClient } from "effect/http";

import { freshCaller, kill, post, prepare, start } from "./workerd.js";

const services = Layer.merge(NodeServices.layer, FetchHttpClient.layer);

const definition = {
  condition: {
    expect: { status: 200 },
    type: "http",
    url: "https://checks.example.invalid/ready",
  },
  intervalSeconds: 60,
  kind: "once",
  label: "Restarted watch",
  message: { body: "Ready", summary: "Ready" },
  notify: { cc: [], to: ["example/desk"] },
  requestId: "watch-test-request",
  timeoutSeconds: 2,
} satisfies typeof armWatchContract.input.Type;

it.live(
  "signed watch routes enforce grants and ownership and the stored alarm wakes a fresh workerd",
  () =>
    Effect.gen(function* watchSurvivesRestart() {
      const peer = yield* freshCaller("watch-peer");
      const ungranted = yield* freshCaller("watch-ungranted");

      const world = yield* prepare(500, [peer, ungranted], undefined, {
        watchOwners: [peer.did],
      });

      const first = yield* start(world);
      const denied = yield* post(world, "armWatch", definition, ungranted);
      expect(denied.body).toMatchObject({ code: "NotGranted" });

      const offHost = yield* post(world, "armWatch", {
        ...definition,
        condition: {
          ...definition.condition,
          url: "https://foreign.example.invalid/",
        },
      });

      expect(offHost.body).toMatchObject({ code: "HostNotAllowed" });
      const armed = yield* post(world, "armWatch", definition);
      expect(armed.status).toBe(200);

      const { watchId } = yield* Schema.decodeUnknownEffect(
        armWatchContract.output
      )(armed.body);

      expect((yield* post(world, "armWatch", definition)).body).toEqual(
        armed.body
      );

      const listing = yield* post(world, "listWatches", {
        owner: world.driver.did,
        target: "example/desk",
      });

      expect(listing.body).toMatchObject({ watches: [{ watchId }] });

      const mismatched = yield* post(world, "listWatches", {
        target: "different/desk",
      });

      expect(mismatched.body).toEqual({ watches: [] });

      for (const name of ["cancelWatch", "completeWatch"]) {
        const deniedStop = yield* post(
          world,
          name,
          { requestId: name, watchId },
          peer
        );

        expect(deniedStop.body).toMatchObject({ code: "NotOwner" });
      }

      const inspect = post(world, "inspectWatch", { watchId }).pipe(
        Effect.flatMap(({ body }) =>
          Schema.decodeUnknownEffect(WatchInspection)(body)
        )
      );

      expect((yield* inspect).watch.state).toBe("armed");
      yield* kill(first);
      yield* start(world);

      const expired = yield* inspect.pipe(
        Effect.filterOrFail(
          ({ watch }) => watch.state === "expired",
          () => "Watch alarm has not expired yet"
        ),
        Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 80 })
      );

      expect(expired.lastCheck).toBeNull();
      expect(expired.firings).toEqual([]);
    }).pipe(Effect.provide(services)),
  15_000
);
