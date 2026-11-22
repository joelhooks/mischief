// @effect-diagnostics-next-line nodeBuiltinImport:off -- Git blob identities require streaming SHA-1 over a length-prefixed byte sequence.
import { createHash } from "node:crypto";

import type { BridgeFailure } from "@mischief/model-bridge/bridge-failure";
import { Effect, FileSystem, Path, Stream } from "effect";
import type { PlatformError } from "effect";

import { Runner } from "../runner.js";
import type { ProcessOutput } from "../runner.js";
import { WorkspaceUnlanded } from "./workspace-unlanded.js";

const limit = 50;

const hashPattern = /^[0-9a-f]{40}$/u;

export const unlanded = (
  reason: string,
  paths: readonly string[] = [],
  refs: readonly string[] = []
) =>
  new WorkspaceUnlanded({
    dirtyPaths: paths.slice(0, limit),
    dirtyTotal: paths.length,
    refs: refs.slice(0, limit),
    message: `${reason} Supply a verified landedHead or explicitly authorize discardWorkspace: true.`,
    status: 409,
  });

const walk = Effect.fn("Box.walkWorkspace")(function* walk<E, R>(
  root: string,
  visit: (
    name: string,
    stat: FileSystem.File.Info
  ) => Effect.Effect<void, E, R>,
  at = "",
  omitGit = false
): Effect.fn.Return<
  void,
  E | PlatformError.PlatformError,
  R | FileSystem.FileSystem | Path.Path
> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  for (const entry of yield* fs.readDirectory(path.join(root, at))) {
    if (omitGit && at === "" && entry === ".git") {
      continue;
    }

    const name = at === "" ? entry : `${at}/${entry}`;
    const stat = yield* fs.lstat(path.join(root, name));

    yield* stat.type === "Directory"
      ? walk(root, visit, name, omitGit)
      : visit(name, stat);
  }
});

type Git = (
  args: readonly string[],
  input?: string,
  objectStore?: boolean
) => Effect.Effect<ProcessOutput, BridgeFailure>;

type ReadGit = (
  args: readonly string[]
) => Effect.Effect<string, BridgeFailure | WorkspaceUnlanded>;

const checkRefs = Effect.fn("Box.checkRefs")(function* checkRefs(
  repo: string,
  head: string,
  git: Git,
  read: ReadGit
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const refs = (yield* read([
    "for-each-ref",
    "--format=%(refname)",
    "refs/heads",
    "refs/tags",
    "refs/remotes",
    "refs/stash",
  ]))
    .split("\n")
    .filter(Boolean);

  const headFile = path.join(repo, "HEAD");

  if ((yield* fs.lstat(headFile)).type !== "File") {
    return yield* unlanded("The workspace Git HEAD is not a regular file.");
  }

  const current = (yield* fs.readFileString(headFile)).trim();

  if (!current.startsWith("ref: refs/heads/") && !hashPattern.test(current)) {
    return yield* unlanded("The workspace Git HEAD is not a branch or commit.");
  }

  const candidates = hashPattern.test(current) ? [...refs, current] : refs;
  const unmerged: string[] = [];

  for (const ref of candidates) {
    if ((yield* git(["merge-base", "--is-ancestor", ref, head])).exit !== 0) {
      unmerged.push(ref);
    }
  }

  if (unmerged.length > 0) {
    return yield* unlanded(
      `${unmerged.length} refs are not ancestors of landedHead: ${unmerged
        .slice(0, limit)
        .map((ref) => JSON.stringify(ref))
        .join(", ")}.`,
      [],
      unmerged
    );
  }

  const abandoned = (yield* read(["rev-list", "--reflog", "--not", head]))
    .split("\n")
    .filter((line) => hashPattern.test(line))
    .toSorted();

  return abandoned;
});

const landedEntries = Effect.fn("Box.landedEntries")(function* landedEntries(
  ignores: string,
  head: string,
  read: ReadGit
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const expected = new Map<string, readonly [string, string]>();

  for (const entry of (yield* read(["ls-tree", "-r", "-z", head]))
    .split("\0")
    .filter(Boolean)) {
    const match =
      /^(?<mode>100644|100755|120000) blob (?<oid>[0-9a-f]{40})\t(?<name>[\s\S]+)$/u.exec(
        entry
      );

    const mode = match?.groups?.mode;
    const oid = match?.groups?.oid;
    const name = match?.groups?.name;

    if (
      mode === undefined ||
      oid === undefined ||
      name === undefined ||
      name
        .split("/")
        .some(
          (segment) =>
            segment === "" ||
            segment === "." ||
            segment === ".." ||
            segment === ".git" ||
            segment.includes("\uFFFD")
        )
    ) {
      return yield* unlanded(
        "The landed tree has an unsupported path or entry type."
      );
    }

    expected.set(name, [mode, oid]);

    if (path.basename(name) === ".gitignore" && mode !== "120000") {
      const target = path.join(ignores, name);
      yield* fs.makeDirectory(path.dirname(target), {
        mode: 0o755,
        recursive: true,
      });
      const rules = yield* read(["cat-file", "blob", oid]);

      if (rules.includes("\uFFFD") || rules.includes("\0")) {
        return yield* unlanded("Landed ignore rules must be UTF-8 text.");
      }

      yield* fs.writeFileString(target, rules, { mode: 0o644 });
    }
  }

  return expected;
});

const compareFiles = Effect.fn("Box.compareFiles")(function* compareFiles(
  work: string,
  expected: Map<string, readonly [string, string]>,
  git: Git
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dirty = new Set<string>();
  const extra: string[] = [];
  yield* walk(
    work,
    (name, stat) =>
      Effect.gen(function* compare() {
        const landed = expected.get(name);
        expected.delete(name);

        if (
          name.includes("\uFFFD") ||
          (stat.type !== "File" && stat.type !== "SymbolicLink")
        ) {
          dirty.add(name);
        } else if (landed === undefined) {
          extra.push(name);
        } else {
          const file = path.join(work, name);
          const digest = createHash("sha1");

          const executable = Math.floor(stat.mode / 0o100) % 2 === 1;
          const fileMode = executable ? "100755" : "100644";
          const mode = stat.type === "SymbolicLink" ? "120000" : fileMode;

          if (stat.type === "SymbolicLink") {
            const bytes = Buffer.from(yield* fs.readLink(file));
            digest.update(`blob ${bytes.length}\0`).update(bytes);
          } else {
            digest.update(`blob ${stat.size}\0`);
            yield* fs.stream(file).pipe(
              Stream.runForEach((chunk) =>
                Effect.sync(() => {
                  digest.update(chunk);
                })
              )
            );
          }

          if (mode !== landed[0] || digest.digest("hex") !== landed[1]) {
            dirty.add(name);
          }
        }
      }),
    "",
    true
  );
  let ignored = 0;

  if (extra.length > 0) {
    const result = yield* git(
      ["check-ignore", "--no-index", "-z", "--stdin"],
      `${extra.join("\0")}\0`,
      false
    );

    if (result.exit !== 0 && result.exit !== 1) {
      return yield* unlanded("Git could not check the landed ignore rules.");
    }

    const ignoredPaths = new Set(result.stdout.split("\0").filter(Boolean));

    for (const name of extra) {
      if (ignoredPaths.has(name)) {
        ignored += 1;
      } else {
        dirty.add(name);
      }
    }
  }

  for (const name of expected.keys()) {
    dirty.add(name);
  }

  if (dirty.size > 0) {
    const paths = [...dirty].toSorted();

    return yield* unlanded(
      `Workspace differs from landedHead at ${paths.length} paths (${ignored} ignored): ${paths
        .slice(0, limit)
        .map((name) => JSON.stringify(name))
        .join(", ")}.`,
      paths
    );
  }

  return ignored;
});

export const verifyWorkspace = Effect.fn("Box.verifyWorkspace")(
  function* verifyWorkspace(
    work: string,
    head: string,
    image: string,
    uid: string,
    gid: number
  ) {
    const runner = yield* Runner;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repo = path.join(work, ".git");
    const objects = path.join(repo, "objects");

    for (const directory of [work, repo, objects]) {
      if (
        (yield* fs.realPath(directory)) !== directory ||
        (yield* fs.lstat(directory)).type !== "Directory"
      ) {
        return yield* unlanded(
          "The workspace and Git object store must be canonical directories."
        );
      }
    }

    const proof = yield* fs.makeTempDirectoryScoped();
    const gitDir = path.join(proof, "repo");
    const ignores = path.join(proof, "ignore");
    yield* fs.chmod(proof, 0o755);

    for (const directory of [
      gitDir,
      ignores,
      path.join(gitDir, "objects"),
      path.join(gitDir, "refs"),
    ]) {
      yield* fs.makeDirectory(directory, { mode: 0o755 });
    }

    yield* fs.writeFileString(path.join(gitDir, "HEAD"), `${head}\n`, {
      mode: 0o644,
    });

    const copy = (relative: string, stat: FileSystem.File.Info) =>
      Effect.gen(function* copyEvidence() {
        if (stat.type !== "File") {
          return yield* unlanded("Git refs and reflogs must be regular files.");
        }

        const target = path.join(gitDir, relative);
        yield* fs.makeDirectory(path.dirname(target), {
          mode: 0o755,
          recursive: true,
        });
        yield* fs.writeFileString(
          target,
          yield* fs.readFileString(path.join(repo, relative)),
          { mode: 0o644 }
        );

        return yield* Effect.void;
      });

    for (const name of ["refs", "logs", "packed-refs"]) {
      const absolute = path.join(repo, name);

      if (!(yield* fs.exists(absolute))) {
        continue;
      }

      const stat = yield* fs.lstat(absolute);

      yield* stat.type === "Directory" && (name === "refs" || name === "logs")
        ? walk(absolute, (relative, entry) =>
            copy(`${name}/${relative}`, entry)
          )
        : copy(name, stat);
    }

    const git: Git = (args, input, objectStore = true) => {
      const command = [
        "run",
        "--rm",
        "-i",
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--user",
        `${uid}:${gid}`,
        "--mount",
        `type=bind,source=${proof},target=/proof,readonly`,
        "--mount",
        `type=bind,source=${objects},target=/objects,readonly`,
        "--workdir",
        "/proof/ignore",
        "--entrypoint",
        "/usr/bin/env",
        image,
        "-i",
        "PATH=/usr/bin:/bin",
        "LANG=C.UTF-8",
        "GIT_CONFIG_NOSYSTEM=1",
        "GIT_CONFIG_GLOBAL=/dev/null",
        "GIT_NO_REPLACE_OBJECTS=1",
        "GIT_DIR=/proof/repo",
        "GIT_WORK_TREE=/proof/ignore",
        ...(objectStore ? ["GIT_OBJECT_DIRECTORY=/objects"] : []),
        "/usr/bin/git",
        "--no-optional-locks",
        "-c",
        "core.excludesFile=/dev/null",
        ...args,
      ];

      return runner.run(
        input === undefined
          ? { executable: "docker", args: command }
          : { executable: "docker", args: command, input }
      );
    };

    const read = (args: readonly string[]) =>
      git(args).pipe(
        Effect.flatMap((result) =>
          result.exit === 0
            ? Effect.succeed(result.stdout)
            : Effect.fail(
                unlanded(
                  "Git could not verify the landed commit and workspace history."
                )
              )
        )
      );

    yield* read(["cat-file", "-e", `${head}^{commit}`]);
    yield* read(["fsck", "--no-reflogs", "--no-dangling", head]);

    const abandoned = yield* checkRefs(repo, head, git, read);
    const expected = yield* landedEntries(ignores, head, read);
    const ignored = yield* compareFiles(work, expected, git);

    return { abandoned, ignored };
  },
  Effect.scoped,
  Effect.catchTag("PlatformError", () =>
    Effect.fail(unlanded("The workspace evidence is unreadable."))
  )
);
