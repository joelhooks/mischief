# Vision

Mischief runs plans of agent work that finish what they start.

A plan is a graph of agent steps stored as data. It runs in one Durable Object per run, on celld or Cloudflare. It fills itself in as results arrive, and it talks to the world only over Rat King. You can stop it, crash it, or pause it at any point. It resumes where it was, and it never re-runs a finished step.

Mischief grew out of [rat-stack](https://github.com/joelhooks/rat-stack) and keeps its law: Effect for the hard parts, Alchemy for the infrastructure, XState for every lifecycle, and a fence that makes the easy path the right one.

## Rat King Claws

Mischief is the **Claws** layer of Rat King: the hands, execution (Joel, 2026-10-17). The Rat King kernel is **Speaks** (comms), **Remembers** (memory) and **Awakes** (durable wakes). Claws composes them into durable dynamic workflows that act in the world: calls, deploys, sends and steps.

- **Claws owns:** step execution, retries, compensation, and the fence that keeps a plan inside its envelope. Compensation is named here but not built yet.
- **Claws borrows:** wakes from Awakes, messages from Speaks, memory from Remembers. It uses their public contracts only, never their internals.
- **Names only.** The repo, packages and code keep the name Mischief until Joel says otherwise.

## Who it serves

- **Joel**, who approves one envelope per run and then answers only the questions the plan cannot answer itself.
- **Joel's desks and agents**, which write plans, run them, and read their results.
- **The agents inside a plan**, which get a bounded configuration, a base minimum of tools, and a way to ask their parent.

## What matters

1. **Durability you can test.** Every durability rule exists because a generated property found the bug it prevents. A run interrupted by any schedule of crashes and pauses ends where an independent plan model ends.
2. **Plans are data.** A plan names registry steps and never carries code. Strict decoding refuses anything the schema does not know.
3. **Bounded autonomy.** Inside the approved envelope, a plan expands and configures itself without asking. Outside it, the plan asks Joel. A confidence ladder (Jev, then `think`, then Joel) keeps the hard cases rare.
4. **Visible state.** Each run, step, and agent can be inspected, paused, resumed, and aborted on every surface: CLI, HTTP, MCP, and a Rat King inbox.
5. **Upstream first.** Mischief leans on `xstate/durable` and pi-durable. When either has a gap, we patch it, prove the patch with the property, and send it upstream.

## Boundaries

- Mischief does not own panes, clones, or landings. Muster does. A plan may `ask` a Muster desk for that work.
- Mischief does not send outward messages to people without the approval rules that already govern Joel's fleet.
- Mischief does not run shell commands from plan steps. Steps use registry tools only.
- Secrets, customer data, and private transcripts stay out of plans, logs, and Rat King plaintext.

The approved design is `.brain/projects/mischief-design.svx`.
