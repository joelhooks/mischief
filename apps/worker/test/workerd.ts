// @effect-diagnostics nodeBuiltinImport:off -- The eviction test runs the real workerd binary as a child process, kills it with SIGKILL and restarts it on the same disk; Effect has no wrapper that sends SIGKILL to a long-running server.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:net";

import { peonContracts } from "@mischief/core";
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
  readonly boxPort?: number | undefined;
}

const PortSchema = Schema.Struct({ port: Schema.Int });

const decodeListening = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      event: Schema.Literal("listen"),
      port: Schema.Int,
      socket: Schema.Literal("http"),
    })
  )
);

const listening = (child: ChildProcess, port: number) =>
  Effect.callback<number>((resume) => {
    let pending = "";

    const onData = (chunk: Buffer) => {
      pending += chunk.toString();
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";

      for (const line of lines) {
        if (
          Option.exists(decodeListening(line), (event) => event.port === port)
        ) {
          resume(Effect.succeed(port));
        }
      }
    };

    const onError = (error: Error) => {
      resume(Effect.die(error));
    };

    const onExit = (code: number | null, signal: string | null) => {
      resume(
        Effect.die(
          `workerd exited before listening on ${port}: code=${code}, signal=${signal}; check the test worker bundle and config.capnp, then rerun the test`
        )
      );
    };

    child.stdout?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);

    return Effect.sync(() => {
      child.stdout?.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    });
  }).pipe(Effect.timeout("5 seconds"));

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
  callers: DocumentsValue,
  jevKey: string | undefined,
  stepKinds: string,
  mailReach: string,
  boxPort: number | undefined
) => `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "main", worker = .worker),
    (name = "disk", disk = (path = "${dir}/do", writable = true)),
    ${boxPort === undefined ? "" : '(name = "box", worker = .boxWorker),'}
  ],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")${boxPort === undefined ? "" : `, (name = "box", address = "127.0.0.1:${boxPort}", http = (), service = "box")`}],
);
const worker :Workerd.Worker = (
  modules = [(name = "worker.js", esModule = embed "worker.js")],
  compatibilityDate = "2026-09-01",
  ${boxPort === undefined ? "" : 'globalOutbound = "box",'}
  durableObjectNamespaces = [
    (className = "PlanRun", uniqueKey = "mischief-plan-run", enableSql = true),
    (className = "ServiceTokenLedger", uniqueKey = "mischief-service-tokens", enableSql = true),
    (className = "Postbox", uniqueKey = "mischief-postbox", enableSql = true),
    (className = "Schedule", uniqueKey = "mischief-schedule", enableSql = true),
    (className = "CallerThinks", uniqueKey = "mischief-caller-thinks", enableSql = true),
    ${boxPort === undefined ? "" : '(className = "Peon", uniqueKey = "mischief-peon", enableSql = true), (className = "PeonTemplates", uniqueKey = "mischief-peon-templates", enableSql = true),'}
  ],
  durableObjectStorage = (localDisk = "disk"),
  bindings = [
    (name = "PLAN_RUN", durableObjectNamespace = "PlanRun"),
    (name = "SERVICE_TOKENS", durableObjectNamespace = "ServiceTokenLedger"),
    (name = "POSTBOX", durableObjectNamespace = "Postbox"),
    (name = "SCHEDULE", durableObjectNamespace = "Schedule"),
    (name = "CALLER_THINKS", durableObjectNamespace = "CallerThinks"),
    ${
      boxPort === undefined
        ? ""
        : `(name = "PEON", durableObjectNamespace = "Peon"),
    (name = "PEON_TEMPLATES", durableObjectNamespace = "PeonTemplates"),
    (name = "MISCHIEF_PEON_BOXES", text = "on"),
    (name = "MISCHIEF_BOX_URL", text = "http://192.0.2.1"),
    (name = "MISCHIEF_BOX_KEY", text = "fake-box-key"),
    (name = "MISCHIEF_PEON_GRANTS", text = ${JSON.stringify(JSON.stringify({ [callers[0]?.id ?? ""]: peonContracts.map(({ name }) => name) }))}),`
    }

    (name = "MISCHIEF_DID", text = "${MISCHIEF_DID}"),
    (name = "MISCHIEF_CALLERS", text = ${JSON.stringify(JSON.stringify(callers))}),
    (name = "MISCHIEF_MAIL_REACH", text = ${JSON.stringify(mailReach)}),
    (name = "MISCHIEF_MODEL", text = "faux"),
    (name = "MISCHIEF_GUARD_MS", text = "${guardMs}"),
    (name = "MISCHIEF_STEP_KINDS", text = ${JSON.stringify(stepKinds)}),
    (name = "MISCHIEF_JUDGE", text = "shadow"),${jevKey === undefined ? "" : `\n    (name = "MISCHIEF_JEV_KEY", text = "${jevKey}"),`}
  ],
);
`;

const boxConfig = `const boxWorker :Workerd.Worker = (
  modules = [(name = "box.js", esModule = embed "box.js")],
  compatibilityDate = "2026-09-01",
  durableObjectNamespaces = [(className = "FakeBox", uniqueKey = "fake-peon-box", enableSql = true)],
  durableObjectStorage = (localDisk = "disk"),
  bindings = [(name = "TEST_BOX", durableObjectNamespace = "FakeBox")],
);
`;

const appDir = Path.Path.use(({ resolve }) =>
  Effect.succeed(resolve(import.meta.dirname, ".."))
);

export const prepare = (
  guardMs: number,
  others: readonly Caller[] = [],
  jevKey?: string,
  options: {
    readonly bundle?: string;
    readonly stepKinds?: string;
    readonly mayMail?: readonly string[];
    readonly mailReach?: string;
    readonly peons?: boolean;
  } = {}
) =>
  Effect.gen(function* prepareWorkerd() {
    const driver = yield* freshCaller("driver");
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const app = yield* appDir;
    const dir = yield* fs.makeTempDirectoryScoped();
    const port = yield* freePort;
    const boxPort = options.peons === true ? yield* freePort : undefined;

    yield* fs.makeDirectory(path.join(dir, "do"));
    yield* fs.copyFile(
      options.bundle ?? path.join(app, "dist", "worker.js"),
      path.join(dir, "worker.js")
    );

    if (boxPort !== undefined) {
      yield* fs.copyFile(
        path.join(app, "dist", "peon-box.js"),
        path.join(dir, "box.js")
      );
    }

    yield* fs.writeFileString(
      path.join(dir, "config.capnp"),
      configOf(
        dir,
        port,
        guardMs,
        [driver, ...others].map(({ document }) => document),
        jevKey,
        options.stepKinds ?? "",
        options.mailReach ??
          JSON.stringify(
            options.mayMail === undefined
              ? {}
              : { [driver.did]: options.mayMail }
          ),
        boxPort
      ) + (boxPort === undefined ? "" : boxConfig)
    );

    return { boxPort, dir, driver, port } satisfies Workerd;
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

export const postStored = (
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

const advancing = new Set([
  "submitPlan",
  "resumeRun",
  "answerRun",
  "deliverReply",
  "extendRun",
]);

const StoredReport = Schema.Struct({
  runId: Schema.String,
  status: Schema.String,
});

const storedReport = Schema.decodeUnknownOption(StoredReport);

export const post = (
  world: Workerd,
  capability: string,
  body: Schema.Json,
  caller: Caller = world.driver
) =>
  Effect.gen(function* storeThenPoll() {
    const stored = yield* postStored(world, capability, body, caller);

    const revision = Schema.decodeUnknownOption(
      Schema.Struct({ dryRun: Schema.Boolean, run: StoredReport })
    )(stored.body);

    const report =
      Option.isSome(revision) && !revision.value.dryRun
        ? Option.some(revision.value.run)
        : storedReport(stored.body);

    if (
      stored.status !== 200 ||
      (!advancing.has(capability) && capability !== "reviseRun") ||
      Option.isNone(report)
    ) {
      return stored;
    }

    const settled = yield* postStored(
      world,
      "inspectRun",
      { runId: report.value.runId },
      caller
    ).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("10 millis"),
        while: ({ body: current }) =>
          Option.match(storedReport(current), {
            onNone: () => false,
            onSome: ({ status }) => status === "running",
          }),
      }),
      Effect.timeout("60 seconds")
    );

    return Option.isSome(revision)
      ? {
          ...settled,
          body: {
            ...(yield* Schema.decodeUnknownEffect(Schema.JsonObject)(
              stored.body
            )),
            run: settled.body,
          },
        }
      : settled;
  });

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
          ["serve", "--control-fd=1", "config.capnp"],
          {
            cwd: world.dir,
            stdio: ["ignore", "pipe", "ignore"],
          }
        )
      ),
      kill
    );

    yield* listening(child, world.port);
    yield* post(world, "inspectRun", {});

    return child;
  });
