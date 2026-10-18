# Host call capabilities

A `call` step invokes a named capability registered by the worker's owner. Plans contain names and JSON data, never executable code. The factory fixes the registry when the worker starts and provides it to each PlanRun through `CallRegistry`.

## Write a capability

Use `callable` from `@mischief/worker` and the same pinned Effect version, `4.0.1`.

```ts
import { callable } from "@mischief/worker";
import type { Callable } from "@mischief/worker";
import { Effect, Schema } from "effect";

export const callables = [
  [
    "count-refs",
    callable({
      input: Schema.Struct({ refs: Schema.Array(Schema.String) }),
      output: Schema.Struct({ count: Schema.Int }),
      run: ({ refs }) => Effect.succeed({ count: refs.length }),
    }),
  ],
] satisfies Iterable<readonly [string, Callable]>;
```

`callable({ input, output, run })` decodes input before invoking `run` and encodes output before journaling it. Schema rejection fails the step. For expected failures, return an Effect with `StepFailed`, also exported by the worker package. Set its `key` to `call.key` and make its `reason` explain the repair.

`run(input, call)` receives a `StepCall`:

| Field   | Meaning                                            |
| ------- | -------------------------------------------------- |
| `runId` | The run's ID.                                      |
| `key`   | The step address, including parallel branch names. |
| `visit` | This step's visit number.                          |
| `epoch` | The execution epoch; revisions can change it.      |

Make side effects idempotent on the complete tuple `(runId, key, visit, epoch)`. Persist the receipt or use the tuple as the downstream service's idempotency key. The same tuple must not cause a second side effect.

Delivery is **at least once across a crash**. A crash before the result commits can repeat the invocation. Completed journal entries replay without invoking the capability. In-process concurrency permits do not provide cross-crash deduplication.

## Keep content outside the run

Use keys, claims and citation references in inputs and outputs. Do not pass raw transcripts, source passages, secrets or customer content through plans, seed docs, results or failure messages. Outputs become docs and journal records. Input docs and literal inputs are durable run data too.

Capabilities execute inside **workerd**, not Node.js. Use pure TypeScript and workerd APIs. A capability may use `fetch` to an owner-approved local service. Do not import `node:` modules, read files, start processes or open arbitrary network access. Keep provider credentials in the service boundary, outside plans and returned data.

## Compose an entry

```ts
import { planRunWorker } from "@mischief/worker";
import { callables } from "./capabilities.js";

const worker = planRunWorker({ callables });

export const { PlanRun, Postbox, Schedule, ServiceTokenLedger } = worker;
export default worker.default;
```

Pass an iterable of `[name, callable]` entries. Names must match `^[a-z][a-z0-9-]{0,63}$`: a lowercase letter followed by at most 63 lowercase letters, digits or hyphens. Construction throws synchronously for an invalid or duplicate name, before the worker accepts requests. The factory snapshots the entries; changing the original map later does not change the worker.

A `Map` is accepted, but JavaScript discards duplicate keys before the factory receives it. Use an array or another entry iterable when composing registries so duplicate names can be refused.

Keep the four exported Durable Object names above. Bindings, migrations, authentication, scheduling and mailbox behavior remain unchanged. This repository's default entry calls the same factory with an empty map.

## Enable only with approval

Registration does not enable the step kind. Set `MISCHIEF_STEP_KINDS=call` in the host's environment to admit `call` steps. It is off by default. **Turning it on for real runs needs the owner's approval.** A test-only binding does not grant that approval.

`MISCHIEF_CALL_CONCURRENCY` caps concurrent capability invocations **per run**, including parallel branches. It defaults to `16`. Set a positive safe whole number, such as `4`, or leave it unset. Invalid values refuse initialization rather than silently changing the cap. It is not a host-wide or downstream-service quota.

A parallel branch can contain this call:

```json
{
  "initial": "count",
  "states": {
    "count": {
      "meta": {
        "step": {
          "capability": "count-refs",
          "input": { "refs": ["cite-a", "cite-b"] },
          "kind": "call",
          "writes": "count-result"
        }
      },
      "on": { "done": { "target": "end" } }
    },
    "end": { "type": "final" }
  }
}
```

Use `reads` instead of literal input when consuming docs. With `reads`, the capability receives an object keyed by the requested doc names. Choose its input schema accordingly.

## Install the git package

The git-consumable package lives at `apps/worker/bundle`. It bundles internal workspace packages and leaves Effect external. It is not published to npm. Do not depend directly on `apps/worker`: that development workspace still declares workspace dependencies.

Pin a full commit sha from `main`, never a branch or floating tag.

```json
{
  "dependencies": {
    "@mischief/worker": "github:joelhooks/mischief#<commit>&path:/apps/worker/bundle",
    "effect": "4.0.1"
  }
}
```

The library ships prebuilt: `apps/worker/bundle` holds the committed `dist/index.js` and `dist/types/` beside its declarations, and has no lifecycle scripts. Installing it runs nothing, needs no `allowBuilds` entry and does not depend on this repository's Node or pnpm versions. The installed package depends only on Effect, with no Mischief workspace dependencies. CI rebuilds the library and fails if the committed files differ, so any commit on `main` carries a library that matches its source. The package ships declarations for workerd projects; include the platform's Worker types in the consumer's TypeScript configuration.

## Build with the infra helper

The infra package exposes `@mischief/infra/build`. Pin it to the same commit with `github:joelhooks/mischief#<commit>&path:/apps/infra`. Its source export needs a TypeScript-capable Alchemy entry.

```ts
import { buildWorker } from "@mischief/infra/build";

const prepared = buildWorker({
  callers,
  commit,
  did,
  entry: workerEntryPath,
  judge,
  mailbox,
  thinker,
  version,
});
```

`buildWorker` returns an Effect that prepares a bundle and configuration; it does not deploy. Pass an absolute entry path. Omitting `entry` uses this repository's default worker. The helper defines `__BUNDLE_COMMIT__` and `__BUNDLE_VERSION__` during bundling, so version responses describe the consumer's build. A custom esbuild pipeline must define those constants, bundle for workerd and leave `cloudflare:workers` external.

The helper retains this repository's declaration and leaves `MISCHIEF_STEP_KINDS` unset. Apply an approved consumer instance name and environment bindings in the consumer's deployment composition. Review its offline plan before deploying. The seam alone does not authorize a deployment or flag change.

## Check the integration

`apps/worker/test/call-worker.test.ts` bundles an invented consumer through both the source export and the committed library. It enables `call` only in its workerd environment, runs two parallel calls, checks docs and invocation tuples, restarts workerd on the same disk, and revises the unchanged plan. Both journal results replay with no new calls.

`apps/worker/test/registered-callables.test.ts` checks duplicate refusal, name validation and registry snapshotting. `apps/infra/test/celld-build.test.ts` checks default and custom builds, unchanged bindings and migrations, default-off flags and no static `node:` imports. These checks do not deploy or enable real runs.
