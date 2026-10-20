// @effect-diagnostics nodeBuiltinImport:off -- This Node CLI reads the lockfile directly from disk.
import { readFileSync } from "node:fs";

export interface StrippedSelector {
  readonly key: string;
  readonly path: string;
}

const KEY = /^ {2}'?(?<key>[^\s'][^']*?)'?:$/u;

const SELECTOR = /#path:(?<path>[^(]+)/u;

const RESOLUTION = /^ {4}resolution: \{(?<body>.*)\}$/u;

const carriesPath = (body: string, path: string): boolean =>
  body.split(", ").includes(`path: ${path}`);

export const findStrippedSelectors = (
  lockfile: string
): readonly StrippedSelector[] => {
  const stripped: StrippedSelector[] = [];
  let inPackages = false;
  let pending: StrippedSelector | undefined;

  for (const line of lockfile.split("\n")) {
    if (/^\S/u.test(line)) {
      inPackages = line === "packages:";
      pending = undefined;
      continue;
    }

    if (!inPackages) {
      continue;
    }

    const key = KEY.exec(line)?.groups?.key;

    if (key !== undefined) {
      const path = SELECTOR.exec(key)?.groups?.path;
      pending = path === undefined ? undefined : { key, path };
      continue;
    }

    const body = RESOLUTION.exec(line)?.groups?.body;

    if (pending !== undefined && body !== undefined) {
      if (!carriesPath(body, pending.path)) {
        stripped.push(pending);
      }

      pending = undefined;
    }
  }

  return stripped;
};

export const refusal = (stripped: readonly StrippedSelector[]): string =>
  [
    `pnpm-lock.yaml dropped the git path selector from ${stripped.length} package(s). Without it every cold install fetches the whole monorepo and fails.`,
    ...stripped.map(
      ({ key, path }) => `  ${key}: resolution must contain "path: ${path}"`
    ),
    "Next call: add the missing `path: <p>` field to each resolution in pnpm-lock.yaml by hand, as commit 05e018f did, then rerun `pnpm run lockfile:check`.",
  ].join("\n");

if (process.argv[1] === import.meta.filename) {
  const stripped = findStrippedSelectors(
    readFileSync(process.argv[2] ?? "pnpm-lock.yaml", "utf-8")
  );

  if (stripped.length > 0) {
    process.stderr.write(`${refusal(stripped)}\n`);
    process.exit(1);
  }
}
