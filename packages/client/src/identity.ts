import { Identity } from "@rat-king/mailbox-client";
import { Effect, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { ClientError } from "./client-error.js";

const Caller = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)?$/u)
);

export const identityLeaseCommand = (caller: string, executable = "secrets") =>
  ChildProcess.make(
    executable,
    [
      "--no-update-check",
      "lease",
      `rat_king_fleet_agent_${caller.replace("/", ".")}_identity`,
      "--ttl",
      "1m",
      "--client-id",
      "mischief-client",
    ],
    { stderr: "ignore", stdin: "ignore", stdout: "pipe" }
  );

const unavailable = () =>
  new ClientError({
    kind: "identity",
    operation: "identity",
    reason:
      "Cannot lease the caller's existing Rat King identity. Check the canonical caller name and agent-secrets on this host, then retry loadIdentity. This client never creates or rotates identities.",
  });

export const loadIdentity = Effect.fn("MischiefClient.loadIdentity")(
  function* loadIdentity(caller: string, executable?: string) {
    yield* Schema.decodeUnknownEffect(Caller)(caller).pipe(
      Effect.mapError(
        () =>
          new ClientError({
            kind: "configuration",
            operation: "identity",
            reason:
              "Invalid caller name. Configure the canonical Rat King name, such as project/desk, then retry loadIdentity. Do not pass an identity or key in argv.",
          })
      )
    );
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const secret = yield* Effect.scoped(
      Effect.gen(function* leaseIdentity() {
        const child = yield* spawner.spawn(
          identityLeaseCommand(caller, executable ?? "secrets")
        );

        const [stdout, code] = yield* Effect.all(
          [
            child.stdout.pipe(Stream.decodeText(), Stream.mkString),
            child.exitCode,
          ],
          { concurrency: "unbounded" }
        );

        if (Number(code) !== 0) {
          return yield* unavailable();
        }

        return stdout.trim();
      })
    ).pipe(Effect.mapError(unavailable));

    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Identity))(
      secret
    ).pipe(
      Effect.mapError(
        () =>
          new ClientError({
            kind: "identity",
            operation: "identity",
            reason:
              "The leased value is not a Rat King identity. Check the caller's existing identity in agent-secrets, then retry loadIdentity; no key material was logged.",
          })
      )
    );
  }
);
