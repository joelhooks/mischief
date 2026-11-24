import { expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { vi } from "vitest";

import { checkHttp, checkPeon, validateHttp } from "../src/watch-check.js";

const url = "https://checks.example.invalid/status";

const host = "checks.example.invalid";

const condition = { expect: { status: 200 }, type: "http", url } as const;

it.effect("disallows foreign hosts and does not follow redirects to them", () =>
  Effect.gen(function* refusesUnsafeFetch() {
    const get = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        headers: { location: "https://off.example.invalid/" },
        status: 302,
      })
    );

    const refused = yield* checkHttp(condition, "off.example.invalid", get);
    expect(refused.outcome).toBe("checkError");
    expect(validateHttp(condition, "off.example.invalid")?.code).toBe(
      "HostNotAllowed"
    );
    const redirected = yield* checkHttp(condition, host, get);
    expect(redirected.outcome).toBe("checkError");
    expect(get.mock.calls).toMatchObject([
      [url, { method: "GET", redirect: "manual" }],
    ]);
  })
);

const check = (body: string, status = 200) =>
  checkHttp(
    {
      ...condition,
      expect: {
        jsonPath: '$.check_runs[?(@.name=="ci")].status',
        equals: "completed",
      },
    },
    host,
    vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status }))
  );

it.effect(
  "requires exactly one matching GitHub check and fails closed on invalid JSON, oversized bodies and server errors",
  () =>
    Effect.gen(function* checksNamedRun() {
      const ci = { name: "ci", status: "completed" };
      const running = { name: "lint", status: "running" };
      expect(
        (yield* check(JSON.stringify({ check_runs: [running, ci] }))).outcome
      ).toBe("true");
      expect(
        (yield* check(JSON.stringify({ check_runs: [running] }))).outcome
      ).toBe("false");
      expect(
        (yield* check(JSON.stringify({ check_runs: [ci, ci] }))).outcome
      ).toBe("false");
      expect((yield* check("no json")).outcome).toBe("checkError");
      expect((yield* check(" ".repeat(64 * 1024 + 1))).outcome).toBe(
        "checkError"
      );
      expect(
        (yield* check(JSON.stringify({ check_runs: [ci] }), 503)).outcome
      ).toBe("checkError");
    })
);

it.effect(
  "a response that stalls while reading the body hits the ten second deadline",
  () =>
    Effect.gen(function* stallDeadline() {
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({ cancel });
      const get = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));

      const probe = yield* checkHttp(
        { ...condition, expect: { regex: "ready" } },
        host,
        get
      ).pipe(Effect.forkChild);

      yield* TestClock.adjust("10 seconds");
      const result = yield* Fiber.join(probe);
      expect(result.outcome).toBe("checkError");
      expect(result.detail).toContain("10 second");
      expect(cancel).toHaveBeenCalledOnce();
    })
);

it.effect(
  "plain JSON paths hash the nearest enclosing object independently of key order",
  () =>
    Effect.gen(function* canonicalPath() {
      const options = {
        ...condition,
        expect: { jsonPath: "$.runs[0].status", equals: "done" },
      };

      const probe = (body: string) =>
        checkHttp(
          options,
          host,
          vi.fn<typeof fetch>().mockResolvedValue(new Response(body))
        );

      const first = yield* probe(
        '{"runs":[{"id":1,"status":"done"}],"unrelated":17}'
      );

      expect(first.outcome).toBe("true");
      expect(
        yield* probe('{"runs":[{"status":"done","id":1}],"unrelated":18}')
      ).toEqual(first);
      expect(
        yield* probe('{"runs":[{"status":"done","id":2}],"unrelated":18}')
      ).not.toEqual(first);
    })
);

it.effect(
  "peon matches depend on current state, pending work and turn identity",
  () =>
    Effect.gen(function* checksPeonStateAndTurn() {
      const peon = {
        expect: { pendingClear: true, state: "idle" },
        peonId: "example",
        type: "peon",
      } as const;

      expect((yield* checkPeon(peon, null)).outcome).toBe("checkError");
      expect(
        (yield* checkPeon(peon, {
          lastTurnId: "turn-one",
          pending: true,
          state: "idle",
        })).outcome
      ).toBe("false");

      const first = yield* checkPeon(peon, {
        lastTurnId: "turn-one",
        pending: false,
        state: "idle",
      });

      const second = yield* checkPeon(peon, {
        lastTurnId: "turn-two",
        pending: false,
        state: "idle",
      });

      expect(first.outcome).toBe("true");
      expect(second.outcome).toBe("true");
      expect(first).not.toEqual(second);
    })
);
