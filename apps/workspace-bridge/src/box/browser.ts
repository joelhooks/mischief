import { PeonTemplate } from "@mischief/core";
import type { PeonState } from "@mischief/core";
import { ByteSize, Effect, FileSystem, Option, Path, Schema } from "effect";

import { refusal } from "../protocol.js";
import { BoxBuildRefused } from "./box-build-refused.js";
import type { BoxTemplate } from "./protocol.js";

export const browserEgressFlags = (hosts: readonly string[]) =>
  Schema.decodeEffect(PeonTemplate.fields.browser.schema.fields.hosts)(
    hosts
  ).pipe(
    Effect.mapError(() =>
      refusal(
        "Browser boxes need a nonempty list of exact test DNS hosts. Supply overrides.browser.hosts without wildcards, addresses or URLs."
      )
    ),
    Effect.map((allowed) =>
      [
        "--proxy-server=http://127.0.0.1:9",
        `--proxy-bypass-list=${allowed.join(";")};<-loopback>`,
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        `--host-resolver-rules=MAP * ~NOTFOUND, ${allowed.map((host) => `EXCLUDE ${host}`).join(", ")}`,
      ].join("\n")
    )
  );

const rootOwned = (info: FileSystem.File.Info) =>
  Option.getOrUndefined(info.uid) === 0;

const trusted = (info: FileSystem.File.Info) =>
  // oxlint-disable-next-line eslint/no-bitwise -- POSIX st_mode encodes group and other write permissions as a bit mask.
  rootOwned(info) && (info.mode & 0o022) === 0;

const executableByBox = (info: FileSystem.File.Info) =>
  // oxlint-disable-next-line eslint/no-bitwise -- POSIX st_mode encodes the unprivileged user's execute bit.
  info.type === "File" && (info.mode & 0o001) === 0o001;

const verifyTree = Effect.fn("Boxes.verifyBurrowTree")(function* verifyTree(
  build: string,
  refused: BoxBuildRefused
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const inside = (target: string) =>
    target === build || target.startsWith(`${build}/`);

  const pending = [build];

  while (pending.length > 0) {
    const directory = pending.pop();

    if (directory === undefined) {
      break;
    }

    for (const name of yield* fs.readDirectory(directory)) {
      const file = path.join(directory, name);
      const info = yield* fs.lstat(file);

      if (info.type === "SymbolicLink") {
        const link = yield* fs.readLink(file);

        if (
          !rootOwned(info) ||
          path.isAbsolute(link) ||
          !inside(path.resolve(directory, link)) ||
          !inside(yield* fs.realPath(file))
        ) {
          return yield* refused;
        }
      } else if (!trusted(info)) {
        return yield* refused;
      } else if (info.type === "Directory") {
        pending.push(file);
      } else if (info.type !== "File") {
        return yield* refused;
      }
    }
  }

  if (!executableByBox(yield* fs.lstat(path.join(build, "helium")))) {
    return yield* refused;
  }

  return yield* Effect.void;
});

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
      "Burrow build or digest receipt is missing, untrusted, or does not match the template. Publish the root-owned build with its executable helium, no escaping links, and matching .sha256 receipt under MISCHIEF_BOX_BROWSER_BUILDS, then retry.",
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
    /[,\p{Cc}]/u.test(root)
  ) {
    return yield* refused;
  }

  return yield* Effect.gen(function* verifyRootCustody() {
    let directory = build;

    while (true) {
      const info = yield* fs.lstat(directory);

      if (info.type !== "Directory" || !trusted(info)) {
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
      !trusted(stat) ||
      ByteSize.toBigInt(stat.size) > 65n
    ) {
      return yield* refused;
    }

    const recorded = yield* fs.readFileString(receipt);

    if (recorded !== sha && recorded !== `${sha}\n`) {
      return yield* refused;
    }

    yield* verifyTree(build, refused);

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
    return { args: [] };
  }

  const { hosts, burrowSha256 } = template.browser;
  const egressFlags = yield* browserEgressFlags(hosts);

  const args = [
    "--env",
    `PEON_BROWSER_HOSTS=${hosts.join(" ")}`,
    "--env",
    `PEON_BROWSER_EGRESS_FLAGS=${egressFlags}`,
  ];

  if (burrowSha256 === undefined) {
    return { args };
  }

  const build = yield* verifyBurrow(buildRoot, burrowSha256, managerUid, state);

  return {
    args: [
      ...args,
      "--mount",
      `type=bind,source=${build},target=/opt/burrow,readonly,bind-recursive=disabled`,
      "--env",
      "BURROW_CELL_IN_BOX=1",
      "--env",
      `BURROW_CELL_EGRESS_FLAGS=${egressFlags}`,
    ],
    build,
  };
});
