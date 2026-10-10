# Agent instructions

For a non-trivial task, start with `skills/rat-stack-mode`, then read `VISION.md` and the approved design in `.brain/projects/mischief-design.svx`.

This file is the repo law for agents and contributors. It holds commands, validation rules, architecture constraints, and project stop rules. Read `VISION.md` for intent before planning substantial work. `VISION.md` does not override this file. Pi sessions also load `.pi/APPEND_SYSTEM.md` and the repo-local extension `.pi/extensions/project.ts`.

## Stack contract

Workspace `package.json` files declare the pinned stack. [README.md](./README.md#what-is-in-the-stack) summarizes it. Keep dependencies exact. Repo-local config wins. Record drift instead of silently migrating the project.

- pnpm workspaces + Turborepo (`apps/*`, `packages/*`)
- Node `>=24.18.0` and pnpm `11.3.0`; do not replace pnpm with Bun or npm for installs
- Effect `4.0.0` and `@effect/platform-node` `4.0.0`, one runtime family. Bumping it is its own change.
- XState `6.0.0-alpha.65` for finite lifecycles, retries, cancellation, and resumability
- `@xstate/effect` `0.1.0-alpha.7` bridges the two: machines run as scoped Effects via `createEffectActor`, side effects are declared `fromEffect` actors. This pin was published to npm 2026-10-08; `vendor/README.md` keeps the rules for the next unpublished pin
- Alchemy `2.0.0-beta.81` (Infrastructure as Effects) for every cloud resource; declared in `apps/infra/alchemy.run.ts`, authenticated through Alchemy profiles, never through env vars in this repo
- TypeScript `7.0.2` in strict mode, patched by `@effect/tsgo` `0.51.1` in `prepare` so the Effect language service diagnostics in `tsconfig.base.json` fail `tsc`, not just the editor. Escape hatch for a real boundary: `// @effect-diagnostics-next-line <rule>:off` with a reason
- `@effect/vitest` `4.0.0` for every Effect test: `it.effect` and `it.layer(layer)`; `Effect.run*` and `ManagedRuntime.make` in test files are a lint error
- `@oxlint/plugins` `1.83.0` for the typed lint rules in `scripts/oxlint-plugin-*.ts` and the vendored [anti-slop](https://github.com/dmmulroy/anti-slop) rules in `tools/oxlint/anti-slop/` (all generic rules plus the Effect group, at `error`). The copy is ours; `UPSTREAM.md` there says where it came from and how to take upstream fixes
- Oxlint `1.83.0` with Ultracite `7.12.0`, Oxfmt `0.68.0`, and Turborepo `2.11.2`
- varlock `1.20.0`: declare every env var in `.env.schema`, never read `.env.local` directly, run `pnpm env:check` after schema edits

The base Effect plugin owns diagnostic severity. Child configs may add exact `allowedUnstableApis` only for modules warned about in that scope. Do not use subtree prefixes, copy severity maps, or set `ignoreEffectWarningsInTscExitCode` to true.

## Packages

| Package | Path | Role |
| --- | --- | --- |
| `@mischief/capability` | `packages/capability` | `defineContract`, `implement`, and the `toCommand`, `toHttpApi`, `toToolkit`, `toRpc`, and `toCodeMode` projections |
| `@mischief/core` | `packages/core` | Domain contracts, capabilities, ports, and lifecycle machines. Today it holds the template's reference `inspectFile` capability, which the first plan capability replaces |
| `@mischief/devtools` | `packages/devtools` | 🐀 devtools cartridge: `CallLog`, `record`, and the `rat_*` capabilities that list, read, dispatch, replay, and diff capability calls |
| `@mischief/cli` | `apps/cli` | Composition root: `stats`, `catalog`, `openapi`, `serve [--devtools]`, `mcp [--code-mode] [--devtools]` |
| `@mischief/infra` | `apps/infra` | Alchemy Stack `Mischief`. Empty until the `plan-run` cartridge lands |

Template packages that mischief dropped on day one (site, web, auth, database, events, deploy, learn, lore) stay in `joelhooks/rat-stack`. Take one back from there when a cartridge needs it.

## Nouns

| Noun | Home | Runtime job |
| --- | --- | --- |
| Contract | `packages/core/src/contracts.ts` | Shared name, schemas, failure, annotations, and approval setting. |
| Capability | `packages/core/src/<name>.ts` | Binds one contract to its server-side handler with `implement`. |
| Projection | `packages/capability/src/to-<surface>.ts` | Expose implemented capabilities on one runtime surface. |
| Cartridge | `packages/<name>/src/` | One Layer with its own infrastructure: added with one line, removed with nothing left behind. |
| Machine | `packages/core/src/<name>-machine.ts` | Own one finite domain lifecycle. |
| Plan | stored data, schema in core | A graph of registry steps plus an envelope. Never code. |
| Step | the step registry | One named, versioned unit of work a plan may reference: `think`, `judge`, `ask`, `ask-joel`, `sketch`, `parallel`. |
| Envelope | part of a plan | The ceiling Joel approves once per run: models, thinking, tools, names, agents, depth, steps, budget, thresholds. |
| Run | one Durable Object | One plan executing durably: snapshot, journal, unconsumed completions, status. |

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm install` | Install workspace dependencies |
| `pnpm check` | Typecheck, verify formatting, and run type-aware linting |
| `pnpm lint` | Type-aware lint plus format check only |
| `pnpm fix` | Apply Oxfmt and safe Oxlint fixes |
| `pnpm test` | Build and run the Vitest suite once |
| `pnpm build` | Compile package outputs |
| `pnpm vendor:agent-sources` | Shallow-clone Effect, effect-solutions, xstate, and alchemy mirrors |
| `pnpm infra:plan` | Preview the Alchemy Stack diff without applying |
| `pnpm exec lefthook install` | Install git hooks (also via `prepare`) |
| `pnpm turbo run check test build` | Required validation before claiming a change is ready |

Run `pnpm fix` only when you intend to rewrite files. Finish with `pnpm turbo run check test build`.

## Deploy

Nothing deploys yet. The deploy driver arrives with the `plan-run` cartridge and follows rat-king's rules: Alchemy state lives outside the repo, `plan` runs offline by default and refuses a delete or replace, a deploy needs an explicit approval switch, and teardown is `destroy-plan`, then `destroy`, then a probe. Resource declarations sit behind `__ALCHEMY_RUNTIME__` because Worker init runs twice. Per-run keys and names never touch Alchemy.

## Fence (cheating is uncomfortable)

Why lives in `AGENTS.md` / `VISION.md`. The stack and hooks are the enforceable fence. Fence wins over prose.

- Lefthook pre-commit runs `pnpm check` and `pnpm test`
- Agents must not use `git … --no-verify` (or equivalent hook bypass)
- Blocked by: Pi `.pi/extensions/git-interceptor`, Cursor `.cursor/hooks.json`, Claude Code `.claude/settings.json`
- Policy source: `scripts/vcs-command-policy.js`

If a hook fails, fix the failure. Do not disable the fence.

## Source-first Effect / XState work

Before writing, reviewing, or refactoring Effect or XState code, read the installed Effect package's `AGENTS.md` first, for example `packages/core/node_modules/effect/AGENTS.md`. It ships with the installed version, so it is never stale. Then inspect vendored source for the pinned versions. Populate mirrors:

```sh
pnpm vendor:agent-sources
# or
./scripts/vendor-agent-sources.sh --refresh
```

Inventory: `.agent_sources/README.md` is generated in the local source mirror and is not part of this repository.

| Need | Path |
| --- | --- |
| Effect Schema, Context.Service, CLI | `.agent_sources/github.com/Effect-TS/effect/` |
| Idiomatic Effect | `.agent_sources/github.com/kitlangton/effect-solutions/` |
| XState | `.agent_sources/github.com/statelyai/xstate/` |
| `@xstate/effect` (v6 Effect bridge) | `.agent_sources/github.com/statelyai/xstate/packages/xstate-effect/` (`README.md`, `docs/`, `src/*.test.ts`) |
| Alchemy resources, Cloudflare, AWS | `.agent_sources/github.com/alchemy-run/alchemy/` and https://alchemy.run/llms.txt |

Refs are derived from the workspace pins, so bumping a package and re-running the script keeps them matched. The `pi-effect` tool reads the Effect mirror in place; it needs no link.

Mirrors are reference material, not runtime dependencies. Exclude them from typecheck, test, lint, and format. Do not vendor product-specific corpora in this template.

## Source control

Preserve existing work. Inspect status before editing, stage only files changed for the current task, and do not commit generated output, secrets, or populated `.agent_sources/github.com/` trees. Use the repository's existing source-control tool; do not initialize or migrate one without approval. Never pass `--no-verify` to git.

## Project law

These are Mischief's product rules. Durable intent lives in `VISION.md`; the approved design lives in `.brain/projects/mischief-design.svx`.

- Plans are data. A plan names registry steps by kind and never carries code. Strict decoding refuses any key the schema does not know, including `@code` and `@expr`. The step registry is fixed, versioned, and owned by core.
- Plans compile to plain XState JSON and are hydrated with `createMachineFromConfig` against the registry. The compiler generates escalation (`<state>__joel`), migration (`<state>__amend`), and branch-failure (`__failed`) states; plan authors never write them.
- Engines are pinned exactly and sit behind Effect ports: `xstate/durable` runs the plan graph, pi-durable runs agent conversations. When an engine has a gap, patch it on our fork, prove the patch with the durability property, and send it upstream with a shrunk counterexample.
- The durability property is the gate. A run interrupted by any generated schedule of crashes, mid-step crashes, and pauses ends where an independent plan model ends, repeats only steps running at a crash, and writes artifacts that decode with the schemas. Every durability rule below exists because a re-introduced bug fails the property. Code the property cannot reach is removed until a property reaches it.
- Durability rules: checkpoint right after `transition()` and before effects; the checkpoint holds the snapshot, per-address visit counts, and every unconsumed completion; restored completions are re-stamped with the restored child's `sessionId`; the host owns the event queue and drops completions from children that are no longer live; failed steps are journaled; the journal key is `logic:<address>#<visit>`; pause, waiting, and refusal change the run's status, never the snapshot; the question asked comes from the state's `meta.ask`.
- The envelope is checked after `transition()` and before effects. A step past the cap never starts. A fan-out starts only if all of its branches fit.
- Outward steps carry idempotency keys: run, step, and visit. A crash repeats every step running at that moment.
- Comms go only over Rat King. A plan never touches Herdr panes, clones, or landings; it may `ask` a Muster desk for that work.
- One contract, every surface. Define schemas and metadata with `defineContract`; bind a server-side handler with `implement` and add the capability to `capabilities`. CLI, HTTP, MCP, RPC, and code mode are projections in `packages/capability`. Do not add a command, route, or tool handler that bypasses a capability.
- Schemas are the contract. Input, output, and failure are Effect `Schema`; JSON Schema, OpenAPI, and the code-mode declarations are derived from them, never hand-written.
- Lifecycles are machines. Finite modes, retries, and cancellation live in XState machines started with `createEffectActor`; side effects live in declared `fromEffect` actors, never inline.
- The sandbox is a surface, not a bypass. Anything reachable from a code-mode program must be a capability and goes through that capability's schemas and handler.
- Gardener rule: add a lint rule before cleaning up a bad pattern; lint baselines only shrink. The routine is `skills/gardener`; before simplifying or replacing a design, run `skills/uncomplect`.
- Tautological tests considered harmful.
- Change-detector tests considered harmful.
- Do not create regression tests for bug fixes without a genuine gap in behavior testing.
- Prefer property and model tests over example tests. A domain rule is an `it.prop` over Effect `Arbitrary` inputs; anything with history (sessions, retries, lifecycles) is a model checked over generated command sequences. Keep example tests for seams. Plant a bug before trusting a new property: it must fail. Reference: the durability property in `~/Code/joelhooks/pi-durable-desk/prototype/test/durability.test.ts`.
- Errors are prompts for the agent that reads them. Each message says what failed, why, the values that would have been accepted, and the exact next call to make (`answerRun` with one of `yes`, `no`; `inspectRun` to see the question). Keep its source context and fail at the boundary. Build-time code references accumulate every independent failure before emitting assets; drift is a warning, never a fallback.
- No comments in code. `no-comments/no-comments` (`scripts/oxlint-plugin-no-comments.ts`) bans them, after Lauren Tan's Dune rule: agents copy comments, and a comment that explains a workaround spreads the workaround. Say it in a name, a type, a test, a commit message, or the Brain. Two kinds survive: tool directives, with the reason inline after `--`, and a one-line `SAFETY:` invariant above a type assertion. TypeScript's `@ts-expect-error`, `@ts-ignore`, and `@ts-nocheck` count as directives here; `typescript/ban-ts-comment` decides which may stay, so write `// @ts-expect-error -- <reason>`. `--fix` deletes prose, so move anything a comment knows into a name, a test, the commit, or the Brain before running it. Plain JS files keep JSDoc blocks made only of type tags (`@param {string} command`), because that is their type syntax; Ultracite's JSDoc description rules are off for the same reason. Credit for borrowed code lives in `PROVENANCE.md`.
- Diagnostic overrides are targeted and explained: `// @effect-diagnostics-next-line <rule>:off -- <reason>`. File-level overrides exist only at projection boundaries (`packages/capability/src/to-toolkit.ts`, `packages/capability/src/to-code-mode.ts`, `packages/capability/src/to-rpc.ts`) and in process-spawning test files.
- Lint overrides follow the same rule: `// oxlint-disable-next-line <rule> -- <reason>`. Every type assertion carries a one-line `SAFETY:` comment naming the invariant it relies on. `unicorn/throw-new-error` is off because `Schema.TaggedError(...)` looks like a throw to it. Anti-slop overrides exist only where a type is erased on purpose (the projections in `packages/capability`, the sandbox RPC boundary, the lint plugin's AST walker); anywhere else, parse the value at its boundary with Effect `Schema`.
- Pins stay exact. A vendored dependency carries a matching `minimumReleaseAgeExclude` entry and a removal rule in `vendor/README.md`.

## Architecture

- Domains are folders named for their job. Planned: `plans/` (store, validator, compiler), `runs/` (`DurableHost`), `thinking/` (pi-durable), `judging/` (Jev), `comms/` (Rat King), `identity/`. Core owns the ports; adapters live outside core and are provided at composition.
- `rat-stack-boundaries/no-core-adapters` keeps provider adapters out of core. `rat-stack-boundaries/no-cross-layer-imports` enforces dependency direction: `apps/cli` → `packages/core` → `packages/capability` → Effect/XState. Packages do not import apps; `apps/infra` owns its Stack wiring.
- `rat-stack-boundaries/no-hand-rolled-surface` keeps `Rpc.make`, `RpcGroup.make`, `HttpApi*`, `Tool.make`, and `Toolkit.make` inside `packages/capability`; everything else projects contracts.
- `rat-stack-patterns` (`scripts/oxlint-plugin-patterns.ts`): `contract-binding-matches-name`, `no-module-level-mutable-state` (module `let`/`var` leaks across Worker requests), `acquire-release-constructs-in-acquire-body`, and `watch-effect-actors`.
- `packages/core/src/file-inspector.ts` is the reference service shape: a `Context.Service` class whose `make` captures its dependencies, with `static layer` beside it. `packages/core/src/config-service.ts` derives a service from Effect `Config`; `AppConfig` mirrors `.env.schema`.
- `packages/core/src/inspect-machine.ts` is the reference lifecycle: the machine owns states, declared `fromEffect` actors own side effects and typed failures. Effect-backed machines start only under `createEffectActor`, never `createActor`. The plan lifecycle (`loading → stepping → committing → waiting | done | refused`) follows this shape.
- Devtools are capabilities: `devtools(capabilities)` adds the `rat_*` capabilities, recorded through `CallWatch`. `rat-stack-boundaries/no-devtools-in-production` keeps devtools out of deployed entries; `--devtools` binds `127.0.0.1` only.
- `apps/cli/src/surfaces.ts` is the only place projections are instantiated; `apps/cli/src/command.ts` maps them to subcommands; `apps/cli/src/cli.ts` is the composition root.

## Boundaries and sign-off

- Safe by default: adding a capability in `packages/core` and wiring it into `capabilities`; new or tightened tests and properties; a targeted diagnostic override with a written reason; README, AGENTS.md, and `.brain/` edits; tightening a lint rule; `pnpm infra:plan`.
- Needs owner sign-off: adding or changing a dependency version (pins are exact and CI installs cold); any edit that loosens the fence (`oxlint.config.ts`, the diagnostics map in `tsconfig.base.json`, `lefthook.yml`, `scripts/vcs-command-policy.js`); any deploy or destroy; widening sandbox permissions or adding a runtime that reaches the network; exposing `serve` or `mcp` beyond localhost; adding a step kind to the registry; changing the envelope's fields; sending anything outward over Rat King to a person; deleting `.agent_sources/` or `vendor/`.
