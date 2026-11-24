import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { build } from "esbuild";

const config = `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (services = [(name = "disk", disk = (path = "do", writable = true)), (name = "watch-rollback", worker = (
  modules = [(name = "watch.js", esModule = embed "watch.js")],
  compatibilityDate = "2026-09-01",
  durableObjectNamespaces = [(className = "StoredWatch", uniqueKey = "watch-rollback", enableSql = true)],
  durableObjectStorage = (localDisk = "disk"),
  bindings = [(name = "WATCH", durableObjectNamespace = "StoredWatch")],
))]);`;

it.effect(
  "refuses requests and ignores alarms without touching stored watch rows",
  () =>
    Effect.gen(function* watchRollback() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const dir = yield* fs.makeTempDirectoryScoped();
      const configPath = path.join(dir, "config.capnp");

      const workerd = path.resolve(
        import.meta.dirname,
        "../node_modules/.bin/workerd"
      );

      yield* fs.makeDirectory(path.join(dir, "do"));
      yield* fs.writeFileString(configPath, config);
      yield* Effect.promise(
        // @effect-diagnostics-next-line asyncFunction:off -- esbuild's Promise is adapted at this boundary.
        async () =>
          await build({
            bundle: true,
            entryPoints: [
              path.join(import.meta.dirname, "fixtures/watch-rollback.ts"),
            ],
            external: ["cloudflare:workers"],
            format: "esm",
            outfile: path.join(dir, "watch.js"),
          })
      );

      const child = yield* spawner.spawn(
        ChildProcess.make(workerd, ["test", configPath], {
          cwd: dir,
          stderr: "pipe",
          stdout: "pipe",
        })
      );

      const collect = (stream: typeof child.stdout) =>
        stream.pipe(Stream.decodeText(), Stream.mkString);

      const [stdout, stderr, code] = yield* Effect.all(
        [collect(child.stdout), collect(child.stderr), child.exitCode],
        { concurrency: "unbounded" }
      );

      expect(Number(code), `${stdout}\n${stderr}`).toBe(0);
      expect(`${stdout}\n${stderr}`).toContain("[ PASS ]");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
