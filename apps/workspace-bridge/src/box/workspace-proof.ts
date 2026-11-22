import { Effect } from "effect";

import { Runner } from "../runner.js";
import { WorkspaceUnlanded } from "./workspace-unlanded.js";

export const unlanded = (reason: string, dirtyPaths: readonly string[] = []) =>
  new WorkspaceUnlanded({
    dirtyPaths,
    message: `${reason} Supply a verified landedHead or explicitly authorize discardWorkspace: true.`,
    status: 409,
  });

export const verifyWorkspace = Effect.fn("Box.verifyWorkspace")(
  function* verifyWorkspace(
    work: string,
    head: string,
    image: string,
    gid: number
  ) {
    const runner = yield* Runner;

    const git = (args: readonly string[]) =>
      runner.run({
        executable: "docker",
        args: [
          "run",
          "--rm",
          "--network",
          "none",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--user",
          `65534:${gid}`,
          "--mount",
          `type=bind,source=${work},target=/work,readonly`,
          "--entrypoint",
          "/usr/bin/git",
          image,
          "--no-optional-locks",
          "-c",
          "safe.directory=/work",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.filemode=true",
          "-C",
          "/work",
          ...args,
        ],
      });

    const commit = yield* git(["cat-file", "-e", "--", `${head}^{commit}`]);

    if (commit.exit !== 0) {
      return yield* unlanded(
        "The supplied landedHead is not a commit in this box's workspace."
      );
    }

    const index = yield* git(["ls-files", "-v", "-z"]);

    if (index.exit !== 0) {
      return yield* unlanded("Git could not inspect the workspace index.");
    }

    const dirty = new Set(
      index.stdout
        .split("\0")
        .filter((entry) => /^[a-zS] /u.test(entry))
        .map((entry) => entry.slice(2))
    );

    for (const args of [
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--ignore-submodules=none",
        "--name-only",
        "-z",
        head,
        "--",
      ],
      [
        "diff",
        "--cached",
        "--no-ext-diff",
        "--no-textconv",
        "--ignore-submodules=none",
        "--name-only",
        "-z",
        head,
        "--",
      ],
      ["ls-files", "--others", "-z"],
    ]) {
      const result = yield* git(args);

      if (result.exit !== 0) {
        return yield* unlanded(
          "Git could not compare this workspace with the supplied landedHead."
        );
      }

      for (const name of result.stdout.split("\0").filter(Boolean)) {
        dirty.add(name);
      }
    }

    if (dirty.size > 0) {
      const paths = [...dirty].toSorted();

      return yield* unlanded(
        `Workspace differs from landedHead at ${paths.map((name) => JSON.stringify(name)).join(", ")}.`,
        paths
      );
    }

    return yield* Effect.void;
  }
);
