# Mischief 🐀

Durable agent plans. A plan is a graph of agent work stored as data. It runs in one Durable Object per run, on celld or Cloudflare, fills itself in as results arrive, and talks to the world only over Rat King. Stop it, crash it, or pause it at any point: it resumes where it was and never re-runs a finished step.

- Why it exists: [`VISION.md`](./VISION.md)
- The rules agents follow: [`AGENTS.md`](./AGENTS.md)
- The approved design: [`.brain/projects/mischief-design.svx`](./.brain/projects/mischief-design.svx)

Mischief started from the [rat-stack](https://github.com/joelhooks/rat-stack) template on 2026-10-10 and keeps its fence: Effect for the hard parts, Alchemy for infrastructure, XState for every lifecycle, and lint, types and hooks that make the easy path the right one.

## Status

Day one. The workspace builds, the fence runs, and the CLI serves the template's reference capability. The first build step is the `plan-run` cartridge: a `PlanRun` Durable Object on celld driven by the durability property from the prototype.

## Run it

Node `24.18.0` and pnpm `11.3.0` are required.

```sh
nvm use
pnpm install
pnpm vendor:agent-sources
pnpm turbo run check test build
pnpm cli stats README.md
```

## What is in the stack

| Piece            | Pin                                                     |
| ---------------- | ------------------------------------------------------- |
| Effect           | `4.0.0`                                                 |
| XState           | `6.0.0-alpha.65` (`xstate/durable` runs the plan graph) |
| `@xstate/effect` | `0.1.0-alpha.7`                                         |
| Alchemy          | `2.0.0-beta.81`                                         |
| TypeScript       | `7.0.2`, patched by `@effect/tsgo`                      |
| Vitest           | `5.0.3` with `@effect/vitest` `4.0.0`                   |

## Workspace

| Path | Package | Role |
| --- | --- | --- |
| `apps/cli` | `@mischief/cli` | Composition root: `stats`, `catalog`, `openapi`, `serve`, `mcp` |
| `apps/infra` | `@mischief/infra` | Alchemy Stack `Mischief` |
| `packages/capability` | `@mischief/capability` | One contract, every surface: CLI, HTTP, MCP, RPC, code mode |
| `packages/core` | `@mischief/core` | Domain contracts, capabilities, ports, and machines |
| `packages/devtools` | `@mischief/devtools` | 🐀 devtools: record, replay, and diff capability calls |
