# Run your first Mischief plan

Mischief stores a plan, runs its steps durably, and keeps its receipt after you abort it. Start with a plan that waits for an answer and sends no mail.

## Opt in for one project

Use a reviewed Mischief checkout. Build the client and its workspace dependencies from that checkout:

```sh
pnpm install --frozen-lockfile
pnpm turbo run build --filter=@mischief/client
```

Add the built extension to your desk's **project-local** `.pi/settings.json` `extensions` list. Preserve the other entries:

```json
{
  "extensions": ["/path/to/mischief/packages/client/dist/pi.js"]
}
```

Record permission to use Mischief in that project's agent policy. Reload Pi after changing its extension list. This package does not install itself or change fleet settings.

In the desk project's `.pi/mischief.json`, configure a host name:

```json
{
  "hosts": {
    "mischief": {
      "audience": "did:web:mischief.example.invalid#mischief",
      "endpoint": "https://mischief.example.invalid"
    }
  }
}
```

Replace the example origin and audience with the values supplied by the host's desk. The audience is the host's DID plus `#mischief`. Use an HTTP(S) origin without a path, credentials, query or fragment. Tool calls use the configured name `mischief`, not an IP address. Prefer HTTPS. With HTTP, the bearer travels in cleartext; use HTTP only for a tailnet-only host.

The launcher supplies this Pi's own canonical Rat King name in `RATKING_NAME`. If that name is `example/desk`, the client leases `rat_king_fleet_agent_example.desk_identity` from local agent-secrets, following pi-ratking's naming convention. A worker named `example/worker` leases its own identity instead. The identity must already exist on this machine, and its DID document must be on the host's caller allowlist.

A repo file never chooses the signing identity. An optional `caller` in `.pi/mischief.json` only asserts the expected session name. If it differs from `RATKING_NAME`, the client refuses before leasing anything and says how to fix the mismatch. An unset, empty or `off` session name also refuses. Start the session under its own Rat King name; do not borrow a desk's name to bypass admission.

The client never creates or rotates keys. The tool invokes `secrets` from the operator's PATH. A repo setting cannot replace that executable; unknown project-config fields, including `secretsCommand`, are refused.

Keep keys out of settings, plans, argv and logs. The client passes only the secret's name to `secrets lease` and imports the returned signing key in-process. It mints a fresh, single-use service token for each HTTP request. It does not retry writes automatically: after a transport failure, inspect the same run before deciding what to retry.

## Write a small plan

Save this as `first-plan.json`. It waits at `question`; both answers lead to `done`. `names: []` means this plan cannot ask another Rat King name.

```json
{
  "defaults": { "agent": {} },
  "envelope": {
    "maxAgents": 1,
    "maxDepth": 3,
    "maxSteps": 10,
    "maxThinking": "low",
    "models": ["sol"],
    "names": [],
    "thresholds": { "judge": 0.8 }
  },
  "version": 1,
  "goal": "Wait for an answer without mailing anyone",
  "id": "first-plan",
  "machine": {
    "id": "first-plan",
    "initial": "question",
    "states": {
      "done": { "type": "final" },
      "question": {
        "meta": {
          "step": { "kind": "ask-joel", "question": "Finish the first plan?" }
        },
        "on": { "no": { "target": "done" }, "yes": { "target": "done" } }
      }
    }
  }
}
```

Plans are data, never code. Unknown plan fields are refused. Put only approved, non-sensitive content in plans and documents.

## Submit and watch

Call `mischief` with the JSON below. Replace `<contents of first-plan.json>` with the parsed JSON object, not a filename or a string:

```text
{
  "host": "mischief",
  "request": {
    "action": "submit",
    "runId": "first-plan-v1",
    "plan": <contents of first-plan.json>
  }
}
```

The tool returns `first-plan-v1 · <status>` and an inspect call. Submission acknowledges storage; it does not mean the plan finished. Call inspect again when you want its current state:

```json
{
  "host": "mischief",
  "request": { "action": "inspect", "runId": "first-plan-v1" }
}
```

The tool's details contain the decoded run report: status, current state, documents and any question. Inspect does not wait or answer a question. Re-submitting the same run id with the same plan and seed documents reports the existing run. A different plan under that id is refused. Use a fresh run id for a new experiment.

## Read the receipt

Inspect shows progress and documents. For the full stored plan and journal, use the SDK's `readRun`. Run SDK code from a project that can resolve the built `@mischief/client` workspace package, or import its built `dist/index.js` by path from your reviewed checkout:

```ts
import { NodeServices } from "@effect/platform-node";
import { projectClient } from "@mischief/client";
import { Console, Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";

const receipt = Effect.gen(function* receipt() {
  const client = yield* projectClient(process.cwd(), "mischief");
  yield* Console.log(
    JSON.stringify(yield* client.readRun({ runId: "first-plan-v1" }))
  );
}).pipe(Effect.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer)));

await Effect.runPromise(receipt);
```

The package also exposes `makeClient(host, identity)` for callers that already hold their Rat King identity. Its methods use the worker's existing capability schemas for input, output and declared failures. `ClientError` distinguishes configuration, identity, input, transport, protocol and host refusals. Host refusal text is preserved unchanged in `reason`; declared failures retain their original type and fields.

## Abort and reply

Abort ends this run for good. Its checkpoint, documents and journal remain readable:

```json
{
  "host": "mischief",
  "request": {
    "action": "abort",
    "reason": "First-plan walkthrough complete",
    "runId": "first-plan-v1"
  }
}
```

Inspect once more to check `aborted`. Aborting an already completed run does not undo work.

For a plan with a Rat King `ask`, deliver the reply using the original ask's `messageId` as `replyTo`:

```json
{
  "host": "mischief",
  "request": {
    "action": "reply",
    "body": "The requested result",
    "from": "example/helper",
    "messageId": "the-reply-message-id",
    "replyTo": "the-original-ask-message-id"
  }
}
```

Preserve the mailbox reply fields. `reply` delivers a Rat King reply; it does not answer the first plan's `ask-joel` question. This minimal Pi tool exposes only submit, inspect, abort and reply. The host's other surfaces provide `answerRun` for explicit question answers.

The SDK also wraps the API's three schedule calls: `createSchedule`, `inspectSchedule` and `completeSchedule`. Completion stops future wakes; a wake already running finishes. All run and schedule state stays on the host, scoped to the caller's DID.

## Host policies (rolling out)

**These policies are not enforced at this client's base revision, `8bcfba2`.** They land separately on the host. Confirm the deployed policy with the host's desk before submitting plans that think or mail. The client surfaces the host's refusal reasons unchanged.

- **Mail reach:** a caller's plans may mail only names the host grants in `callers.json`, under `mischief.mayMail`. The default grant is the caller's own Rat King name. A plan naming anything outside that grant is refused at submit, with the name and the fix. `joel-phone` needs an explicit grant; none is granted. The plan's `envelope.names` must also include each recipient. Adding a name to the envelope does not grant host permission.
- **Per-caller share:** `MISCHIEF_CALLER_THINKS` sets concurrent thinks across all of one caller's runs, default 40. Thinks above that share wait and are re-driven. They are not refused, and waiting spends no retry attempts. `inspectRun` reports waiting for caller share. The caller receives one notice per crossing. The host owns this setting; splitting work across run ids does not increase the caller's share.

These rollout values remain subject to their host changes' review. Neither policy changes the requirement for approval before sending a message to a person.

### Host mail reach configuration

Merge this fragment into the agent-graph driver's existing public DID document in `MISCHIEF_CALLERS_FILE`. Keep its authentication, keyAgreement and verificationMethod fields. This sample grants exactly the ten recipients confirmed by the agent-graph desk for its live plans and enabled schedule on 2026-11-04:

```json
{
  "id": "did:web:agent-graph.driver.pi.ratking-fleet.invalid",
  "mischief": {
    "mayMail": [
      "agent-graph/desk",
      "agent-graph/nest-feed",
      "agent-graph/nest-views-a",
      "agent-graph/nest-views-b",
      "aih-support-sweep/desk",
      "drovr/copy-tool",
      "drovr/drovr-desk-2",
      "front-desk/front-desk-desk",
      "rats-nest/rats-nest-desk",
      "switchboard"
    ]
  }
}
```

The deploy reads each document's optional `mischief.mayMail` into `MISCHIEF_MAIL_REACH`, a JSON map keyed by caller DID. It sends only public DID documents through `MISCHIEF_CALLERS`. Missing grants mean self only; an explicit empty array means no mail. Malformed config or an unrecognised caller DID never grants access.

`did:web:<project>.<desk>.pi.ratking-fleet.invalid` derives `<project>/<desk>`. `did:web:<name>.ratking-fleet.invalid` derives `<name>`. Agent-graph submits as `agent-graph/driver`, not `agent-graph/desk`.

Submit checks every envelope name, including unused names. Delivery checks the recipient of the stored sealed envelope against current host config. Removing a grant can therefore refuse a pending step in an old run, without re-sealing its message. Caller-supplied `escalateTo` on submit and schedule creation must also be inside reach, and every escalation delivery re-checks the persisted target. A denied schedule notice logs the refusal but still sends the host-owned copy to `pi-durable/desk`. Host-configured alarm and telemetry recipients remain host-owned.

Run messages end with one line: `Mischief caller: <caller name>; run: <run id>`. Attribution is added before sealing, including for host notices sent on a run's behalf. Retries preserve the stored sealed bytes. Already-sealed envelopes from before rollout keep their original text without a footer; send-time reach still applies. The pinned mailbox client's text sealing API has no record-attribution fields.

Before deploying, merge the grants into the real callers file and check stored live envelopes against them. Count outstanding sealed mail in each PlanRun checkpoint's `pending` directives and journaled sealed records; `mischief_outbox` per PlanRun holds record-only deliveries, not the real-mail pending queue. Postbox abort notifications also retain sealed bytes in `postbox_delivered.envelope` where `notified = 0`. This sample is not a deploy or a grant on the running host.

## Desk-run live proof

The repository test exercises submit, inspect, receipt read and abort against the in-repo workerd harness. That is not a live-host result.

After the desk approves a live check, run this **from the desk project containing `.pi/mischief.json`**, using the reviewed checkout's built script. Keep the desk session's own `RATKING_NAME` in the environment:

```sh
node /path/to/mischief/packages/client/dist/live-proof.js mischief
```

The script creates a unique `client-proof-<uuid>` run with the no-mail plan above. It submits, inspects, prints the stored receipt and aborts. Cleanup also attempts the abort if inspection fails. It takes one argument, the configured host name, and discovers the caller's identity exactly as the tool does. It never takes a signing key in argv. Keep the output as the desk's proof receipt. This script is provided for the desk; the client lane does not run it against the live host.
