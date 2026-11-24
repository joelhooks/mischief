import { Effect, FileSystem, Path } from "effect";

import { refusal } from "../protocol.js";
import type { Command } from "../runner.js";
import { checked } from "../runner.js";
import type { BoxTemplate } from "./protocol.js";

const buildRefusal = () =>
  refusal(
    "Burrow release is missing, differs from its pinned tarball, or is outside the configured build root. Publish the verified immutable release under MISCHIEF_BOX_BROWSER_BUILDS, then retry with its exact overrides.browser.burrowSha256.",
    409
  );

const runBuildCheck = (command: Command) =>
  checked(command).pipe(Effect.mapError(buildRefusal));

const archivePaths = (listing: string) => {
  const paths = new Set<string>();

  for (const entry of listing.split("\n")) {
    const relative = entry.replace(/^\.\//u, "").replace(/\/$/u, "");

    if (relative !== "" && relative !== ".") {
      const parts = relative.split("/");

      for (let count = 1; count <= parts.length; count += 1) {
        paths.add(parts.slice(0, count).join("/"));
      }
    }
  }

  return paths;
};

const verifyBurrow = Effect.fn("Boxes.verifyBurrow")(
  function* verifyBurrow(root: string, sha: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const release = path.join(root, sha);
    const archive = path.join(release, "burrow-linux-x64.tar.gz");
    const build = path.join(release, "unpacked");

    if (
      !path.isAbsolute(root) ||
      root === "/" ||
      root !== path.normalize(root) ||
      root.includes(",") ||
      (yield* fs.realPath(archive)) !== archive ||
      (yield* fs.realPath(build)) !== build ||
      (yield* fs.lstat(archive)).type !== "File" ||
      (yield* fs.lstat(build)).type !== "Directory"
    ) {
      return yield* buildRefusal();
    }

    const checksum = yield* runBuildCheck({
      args: ["--", archive],
      executable: "sha256sum",
    });

    if (checksum.split(/\s/u)[0] !== sha) {
      return yield* buildRefusal();
    }

    const expected = archivePaths(
      yield* runBuildCheck({
        args: ["--quoting-style=escape", "-tzf", archive],
        executable: "tar",
      })
    );

    const inventory = yield* runBuildCheck({
      args: [build, "-mindepth", "1", "-printf", "%P\\0"],
      executable: "find",
    });

    const actual = new Set(inventory.split("\0").filter(Boolean));

    if (
      expected.size === 0 ||
      expected.size !== actual.size ||
      [...expected].some((entry) => !actual.has(entry))
    ) {
      return yield* buildRefusal();
    }

    yield* runBuildCheck({
      args: ["--directory", build, "--compare", "--gzip", "--file", archive],
      executable: "tar",
    });

    return build;
  },
  Effect.catchTag("PlatformError", () => Effect.fail(buildRefusal()))
);

export const browserArgs = Effect.fn("Boxes.browserArgs")(function* browserArgs(
  template: BoxTemplate,
  buildRoot: string
) {
  if ((template.imageKey === "browser") !== (template.browser !== undefined)) {
    return yield* refusal(
      "Browser boxes need a nonempty list of exact test hostnames. Set browser.hosts for the browser image key; omit browser settings for full boxes."
    );
  }

  if (template.browser === undefined) {
    return [];
  }

  const { hosts, burrowSha256 } = template.browser;
  const args = ["--env", `PEON_BROWSER_HOSTS=${hosts.join(" ")}`];

  if (burrowSha256 === undefined) {
    return args;
  }

  const build = yield* verifyBurrow(buildRoot, burrowSha256);

  return [
    ...args,
    "--mount",
    `type=bind,source=${build},target=/opt/burrow,readonly,bind-recursive=disabled`,
    "--env",
    "BURROW_CELL_IN_BOX=1",
  ];
});
