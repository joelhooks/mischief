import { Mail, StepFailed } from "@mischief/core";
import type { StepCall } from "@mischief/core";
import { Effect, Layer, Predicate, Schedule, Schema, Stream } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { NestUncertain } from "./nest-uncertain.js";

export const NEST_EXIT = { conflict: 5, refused: 2, uncertain: 6 } as const;

const SealedLineSchema = Schema.fromJsonString(
  Schema.Struct({ envelope: Schema.Json, messageId: Schema.String })
);

const ReceiptSchema = Schema.fromJsonString(
  Schema.Struct({ id: Schema.String, seq: Schema.Finite })
);

export interface NestConfig {
  readonly as: string;
  readonly backoff?: Schedule.Schedule<unknown>;
  readonly bin: string;
}

export const NEST_SEND_TRIES = 5;

interface NestRun {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}

const text = (stream: Stream.Stream<Uint8Array, PlatformError>) =>
  stream.pipe(Stream.decodeText(), Stream.mkString);

export const mailNest = ({
  as,
  backoff = Schedule.exponential("200 millis"),
  bin,
}: NestConfig) =>
  Layer.effect(
    Mail,
    Effect.gen(function* makeMailNest() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const nest = (call: StepCall, args: readonly string[], input?: string) =>
        Effect.scoped(
          Effect.gen(function* run() {
            const child = yield* spawner.spawn(
              ChildProcess.make(bin, [...args], {
                stderr: "pipe",
                stdin:
                  input === undefined
                    ? "ignore"
                    : Stream.make(new TextEncoder().encode(input)),
                stdout: "pipe",
              })
            );

            const [stdout, stderr, code] = yield* Effect.all(
              [text(child.stdout), text(child.stderr), child.exitCode],
              { concurrency: "unbounded" }
            );

            return { code: Number(code), stderr, stdout } satisfies NestRun;
          })
        ).pipe(
          Effect.mapError(
            ({ message }) =>
              new StepFailed({
                key: call.key,
                reason: `could not run ${bin} ${args[0] ?? ""}: ${message}. Set MISCHIEF_NEST to the nest binary, then resume the run`,
              })
          )
        );

      const refused = (call: StepCall, verb: string, run: NestRun) =>
        new StepFailed({
          key: call.key,
          reason:
            run.code === NEST_EXIT.conflict
              ? `Rat King refused the send as a conflict: different bytes under an admitted message id. Mischief resends only the journaled seal, so this is a bug; report it with the run id. nest said: ${run.stderr.trim()}`
              : `nest ${verb} exited ${run.code}: ${run.stderr.trim() || "no reason given"}. Fix the name or identity, then resume the run`,
        });

      return Mail.of({
        seal: (call) =>
          Effect.gen(function* seal() {
            const run = yield* nest(call, [
              "seal",
              "--as",
              as,
              "--to",
              call.to,
              "--body",
              call.message,
              "--summary",
              `mischief ${call.runId}/${call.key}#${call.visit}`,
            ]);

            if (run.code !== 0) {
              return yield* refused(call, "seal", run);
            }

            const line = yield* Schema.decodeEffect(SealedLineSchema)(
              run.stdout.trim()
            ).pipe(
              Effect.mapError(
                () =>
                  new StepFailed({
                    key: call.key,
                    reason: `nest seal printed something other than {messageId, envelope}: ${run.stdout.slice(0, 200)}. Check that MISCHIEF_NEST points at a nest with the seal command`,
                  })
              )
            );

            return {
              envelope: JSON.stringify(line.envelope),
              messageId: line.messageId,
            };
          }),
        send: (call, sealed) =>
          Effect.gen(function* send() {
            const run = yield* nest(
              call,
              ["send", "--as", as, "--sealed", "-"],
              sealed.envelope
            );

            if (run.code === NEST_EXIT.uncertain) {
              return yield* new NestUncertain({ stderr: run.stderr });
            }

            if (run.code !== 0) {
              return yield* refused(call, "send", run);
            }

            return yield* Schema.decodeEffect(ReceiptSchema)(
              run.stdout.trim()
            ).pipe(
              Effect.asVoid,
              Effect.mapError(
                () =>
                  new StepFailed({
                    key: call.key,
                    reason: `nest send accepted but printed no receipt: ${run.stdout.slice(0, 200)}`,
                  })
              )
            );
          }).pipe(
            Effect.retry({
              schedule: backoff,
              times: NEST_SEND_TRIES - 1,
              while: Predicate.isTagged("NestUncertain"),
            }),
            Effect.catchTag("NestUncertain", ({ stderr }) =>
              Effect.fail(
                new StepFailed({
                  key: call.key,
                  reason: `Rat King did not confirm the send after ${NEST_SEND_TRIES} tries: ${stderr.trim()}. The sealed bytes are journaled; resume the run to resend them`,
                })
              )
            )
          ),
      });
    })
  );
