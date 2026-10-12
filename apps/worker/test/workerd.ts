// @effect-diagnostics nodeBuiltinImport:off -- The eviction test runs the real workerd binary as a child process, kills it with SIGKILL and restarts it on the same disk; Effect has no wrapper that sends SIGKILL to a long-running server.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:net";

import type { DocumentsValue } from "@rat-king/mailbox-client/auth";
import { Effect, FileSystem, Option, Path, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { bearer, freshCaller, MISCHIEF_DID } from "./callers.js";
import type { Caller } from "./callers.js";

export { AUDIENCE, bearer, freshCaller, MISCHIEF_DID } from "./callers.js";

export type { Caller, ClaimsChange } from "./callers.js";

export interface Workerd {
  readonly dir: string;
  readonly driver: Caller;
  readonly port: number;
}

const PortSchema = Schema.Struct({ port: Schema.Int });

const freePort = Effect.callback<number>((resume) => {
  const server = createServer();

  server.listen(0, "127.0.0.1", () => {
    const port = Schema.decodeUnknownOption(PortSchema)(server.address());

    server.close(() => {
      resume(
        Option.match(port, {
          onNone: () => Effect.die("the OS gave no port"),
          onSome: ({ port: found }) => Effect.succeed(found),
        })
      );
    });
  });
});

const configOf = (
  dir: string,
  port: number,
  guardMs: number,
  callers: DocumentsValue
) => `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "main", worker = .worker),
    (name = "disk", disk = (path = "${dir}/do", writable = true)),
  ],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")],
);
const worker :Workerd.Worker = (
  modules = [(name = "worker.js", esModule = embed "worker.js")],
  compatibilityDate = "2026-09-01",
  durableObjectNamespaces = [
    (className = "PlanRun", uniqueKey = "mischief-plan-run", enableSql = true),
    (className = "ServiceTokenLedger", uniqueKey = "mischief-service-tokens", enableSql = true),
    (className = "Postbox", uniqueKey = "mischief-postbox", enableSql = true),
    (className = "Schedule", uniqueKey = "mischief-schedule", enableSql = true),
  ],
  durableObjectStorage = (localDisk = "disk"),
  bindings = [
    (name = "PLAN_RUN", durableObjectNamespace = "PlanRun"),
    (name = "SERVICE_TOKENS", durableObjectNamespace = "ServiceTokenLedger"),
    (name = "POSTBOX", durableObjectNamespace = "Postbox"),
    (name = "SCHEDULE", durableObjectNamespace = "Schedule"),
    (name = "MISCHIEF_DID", text = "${MISCHIEF_DID}"),
    (name = "MISCHIEF_CALLERS", text = ${JSON.stringify(JSON.stringify(callers))}),
    (name = "MISCHIEF_MODEL", text = "faux"),
    (name = "MISCHIEF_GUARD_MS", text = "${guardMs}"),
    (name = "MISCHIEF_JUDGE", text = "shadow"),
  ],
);
`;

const appDir = Path.Path.use(({ resolve }) =>
  Effect.succeed(resolve(import.meta.dirname, ".."))
);

export const prepare = (guardMs: number, others: readonly Caller[] = []) =>
  Effect.gen(function* prepareWorkerd() {
    const driver = yield* freshCaller("driver");
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const app = yield* appDir;
    const dir = yield* fs.makeTempDirectoryScoped();
    const port = yield* freePort;

    yield* fs.makeDirectory(path.join(dir, "do"));
    yield* fs.copyFile(
      path.join(app, "dist", "worker.js"),
      path.join(dir, "worker.js")
    );
    yield* fs.writeFileString(
      path.join(dir, "config.capnp"),
      configOf(
        dir,
        port,
        guardMs,
        [driver, ...others].map(({ document }) => document)
      )
    );

    return { dir, driver, port } satisfies Workerd;
  });

export const postAs = (
  { port }: Workerd,
  capability: string,
  body: Schema.Json,
  authorization: string
) =>
  HttpClientRequest.post(`http://127.0.0.1:${port}/${capability}`).pipe(
    HttpClientRequest.setHeader("authorization", authorization),
    HttpClientRequest.bodyJsonUnsafe(body),
    HttpClient.execute,
    Effect.flatMap((response) =>
      response.json.pipe(
        Effect.map((json) => ({ body: json, status: response.status }))
      )
    )
  );

export const post = (
  world: Workerd,
  capability: string,
  body: Schema.Json,
  caller: Caller = world.driver
) =>
  bearer(caller, capability).pipe(
    Effect.flatMap((authorization) =>
      postAs(world, capability, body, authorization)
    )
  );

export const getJson = ({ port }: Workerd, route: string, authorization = "") =>
  HttpClientRequest.get(`http://127.0.0.1:${port}${route}`).pipe(
    HttpClientRequest.setHeader("authorization", authorization),
    HttpClient.execute,
    Effect.flatMap((response) =>
      response.json.pipe(
        Effect.map((json) => ({ body: json, status: response.status }))
      )
    )
  );

const exited = (child: ChildProcess) =>
  Effect.callback<string>((resume) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resume(Effect.succeed("exited"));

      return;
    }

    child.once("exit", () => {
      resume(Effect.succeed("exited"));
    });
  });

export const kill = (child: ChildProcess) =>
  Effect.sync(() => child.kill("SIGKILL")).pipe(Effect.andThen(exited(child)));

export const start = (world: Workerd) =>
  Effect.gen(function* startWorkerd() {
    const path = yield* Path.Path;
    const app = yield* appDir;

    const child = yield* Effect.acquireRelease(
      Effect.sync(() =>
        spawn(
          path.join(app, "node_modules", ".bin", "workerd"),
          ["serve", "config.capnp"],
          {
            cwd: world.dir,
            stdio: ["ignore", "ignore", "ignore"],
          }
        )
      ),
      kill
    );

    yield* post(world, "inspectRun", {}).pipe(
      Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 100 })
    );

    return child;
  });
