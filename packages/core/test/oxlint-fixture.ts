import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export const repoRoot = `${import.meta.dirname}/../../..`;

export interface OxlintRun {
  readonly config: unknown;
  readonly prefix: string;
  readonly source: string;
}

const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(Stream.decodeText(), Stream.mkString);

export const runOxlint = ({ config, prefix, source }: OxlintRun) =>
  Effect.gen(function* oxlintRun() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix });
    const configPath = path.join(directory, "oxlint.json");
    const file = path.join(directory, "fixture.ts");

    yield* fs.writeFileString(configPath, JSON.stringify(config));
    yield* fs.writeFileString(file, source);

    const child = yield* spawner.spawn(
      ChildProcess.make(
        path.join(repoRoot, "node_modules/.bin/oxlint"),
        ["-c", configPath, "--no-ignore", file],
        { cwd: repoRoot, stderr: "pipe", stdout: "pipe" }
      )
    );

    const [stdout, stderr, code] = yield* Effect.all(
      [collect(child.stdout), collect(child.stderr), child.exitCode],
      { concurrency: "unbounded" }
    );

    return { output: `${stdout}${stderr}`, status: Number(code) };
  }).pipe(Effect.scoped);
