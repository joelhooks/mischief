# Mischief 🐀

Durable agent plans. A plan is a graph of agent work stored as data. It runs in one Durable Object per run, on celld or Cloudflare, fills itself in as results arrive, and talks to the world only over Rat King. Stop it, crash it, or pause it at any point: it resumes where it was and never re-runs a finished step.

- Why it exists: [`VISION.md`](./VISION.md)
- The rules agents follow: [`AGENTS.md`](./AGENTS.md)
- The design notes: kept in the maintainers' private Brain; `.brain/` is gitignored here.

Mischief started from the [rat-stack](https://github.com/joelhooks/rat-stack) template on 2026-10-10 and keeps its fence: Effect for the hard parts, Alchemy for infrastructure, XState for every lifecycle, and lint, types and hooks that make the easy path the right one.

## Status

Early, and dogfooded daily. Today a run executes from the CLI with a file store: plans validate and compile, steps journal before their effects, and a run survives kills mid-step without redoing finished work. Agent turns run on Pi Durable against a real model, judges gate work (including inside parallel branches), and mail goes out and comes back over Rat King, exactly once across crashes. Next: replaying a revised plan from its journal, forking agent sessions, and the `PlanRun` Durable Object on celld and Cloudflare.

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
| Effect           | `4.0.1`                                                 |
| XState           | `6.0.0-alpha.65` (`xstate/durable` runs the plan graph) |
| `@xstate/effect` | `0.1.0-alpha.7`                                         |
| Alchemy          | `2.0.0-beta.81`                                         |
| TypeScript       | `7.0.2`, patched by `@effect/tsgo`                      |
| Vitest           | `5.0.3` with `@effect/vitest` `4.0.1`                   |

## Workspace

| Path | Package | Role |
| --- | --- | --- |
| `apps/cli` | `@mischief/cli` | Composition root: `stats`, `catalog`, `openapi`, `serve`, `mcp` |
| `apps/infra` | `@mischief/infra` | Alchemy Stack `Mischief` |
| `packages/capability` | `@mischief/capability` | One contract, every surface: CLI, HTTP, MCP, RPC, code mode |
| `packages/core` | `@mischief/core` | Domain contracts, capabilities, ports, and machines |
| `packages/devtools` | `@mischief/devtools` | 🐀 devtools: record, replay, and diff capability calls |
