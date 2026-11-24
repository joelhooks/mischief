import type { PeonState } from "@mischief/core";
import { ByteSize, Effect, FileSystem, Option, Path } from "effect";

import { refusal } from "../protocol.js";
import { BoxBuildRefused } from "./box-build-refused.js";
import type { BoxTemplate } from "./protocol.js";

const rootOwned = (info: FileSystem.File.Info) =>
  // oxlint-disable-next-line eslint/no-bitwise -- POSIX st_mode encodes group and other write permissions as a bit mask.
  Option.getOrUndefined(info.uid) === 0 && (info.mode & 0o022) === 0;

const verifyBurrow = Effect.fn("Boxes.verifyBurrow")(function* verifyBurrow(
  root: string,
  sha: string,
  managerUid: string,
  state: typeof PeonState.Type | undefined
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const build = path.join(root, sha);
  const receipt = `${build}.sha256`;

  const details = {
    message:
      "Burrow build or digest receipt is missing, writable outside root, or does not match the template. Publish the root-owned build and matching .sha256 receipt under MISCHIEF_BOX_BROWSER_BUILDS as a separate operator, then retry.",
    status: 409,
  } satisfies Pick<BoxBuildRefused, "message" | "status">;

  const refused = new BoxBuildRefused(
    state === undefined ? details : { ...details, state }
  );

  if (
    !/^[1-9][0-9]*$/u.test(managerUid) ||
    !path.isAbsolute(root) ||
    root === "/" ||
    root !== path.normalize(root) ||
    root.includes(",")
  ) {
    return yield* refused;
  }

  return yield* Effect.gen(function* verifyRootCustody() {
    let directory = build;

    while (true) {
      const info = yield* fs.lstat(directory);

      if (info.type !== "Directory" || !rootOwned(info)) {
        return yield* refused;
      }

      const parent = path.dirname(directory);

      if (directory === parent) {
        break;
      }

      directory = parent;
    }

    const stat = yield* fs.lstat(receipt);

    if (
      stat.type !== "File" ||
      !rootOwned(stat) ||
      ByteSize.toBigInt(stat.size) > 65n
    ) {
      return yield* refused;
    }

    const recorded = yield* fs.readFileString(receipt);

    if (recorded !== sha && recorded !== `${sha}\n`) {
      return yield* refused;
    }

    return build;
  }).pipe(Effect.catchTag("PlatformError", () => Effect.fail(refused)));
});

export const browserArgs = Effect.fn("Boxes.browserArgs")(function* browserArgs(
  template: BoxTemplate,
  buildRoot: string,
  managerUid: string,
  state?: typeof PeonState.Type
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

  const build = yield* verifyBurrow(buildRoot, burrowSha256, managerUid, state);

  return [
    ...args,
    "--mount",
    `type=bind,source=${build},target=/opt/burrow,readonly,bind-recursive=disabled`,
    "--env",
    "BURROW_CELL_IN_BOX=1",
  ];
});
