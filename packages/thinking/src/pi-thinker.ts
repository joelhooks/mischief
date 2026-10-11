// @effect-diagnostics asyncFunction:off -- pi-durable commits and listeners take async callbacks at this adapter boundary.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  defineDoc,
  Harness,
  UsageDoc,
  watchEvents,
} from "@earendil-works/pi-durable";
import type {
  Conversation,
  ConversationId,
  HarnessOptions,
  ModelRef,
  Storage,
} from "@earendil-works/pi-durable";
import type { AgentConfig, StepCall } from "@mischief/core";
import { StepFailed, Thinker } from "@mischief/core";
import {
  Deferred,
  Effect,
  Layer,
  Option,
  Ref,
  Schema,
  Semaphore,
} from "effect";

const StepsDoc = defineDoc<{ byAddress: Record<string, ConversationId> }>({
  fork: "initial",
  history: "latest",
  initial: () => ({ byAddress: {} }),
  kind: "mischief.steps",
  scope: "conversation",
  version: 1,
});

export interface PiThinkerOptions {
  readonly models: HarnessOptions["models"];
  readonly registry: HarnessOptions["registry"];
  readonly modelRefs: Readonly<Record<string, ModelRef>>;
  readonly storageFor: (runId: string) => Effect.Effect<Storage, StepFailed>;
}

interface OpenRun {
  readonly harness: Harness;
  readonly fresh: boolean;
}

interface Answer {
  readonly text: string;
  readonly tokens: number;
  readonly usd: number;
}

const DecisionSchema = Schema.fromJsonString(
  Schema.Struct({
    choice: Schema.String,
    confidence: Schema.Finite.check(
      Schema.isBetween({ maximum: 1, minimum: 0 })
    ),
  })
);

const pi = <A>(call: StepCall, operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    catch: (cause) =>
      new StepFailed({
        key: call.key,
        reason: `pi-durable ${operation} failed: ${cause instanceof Error ? cause.message : String(cause)}. The run can be resumed; a resume reopens the same conversation and submission`,
      }),
    try: run,
  });

const addressOf = (call: StepCall) => `${call.key}#${call.visit}`;

export const piThinker = (options: PiThinkerOptions) =>
  Layer.effect(
    Thinker,
    Effect.gen(function* make() {
      const open = yield* Ref.make(new Map<string, Harness>());
      const opening = yield* Semaphore.make(1);

      yield* Effect.addFinalizer(() =>
        Ref.get(open).pipe(
          Effect.flatMap((harnesses) =>
            Effect.forEach(
              harnesses.values(),
              (harness) =>
                Effect.promise(async () => {
                  await harness.close(BACKGROUND_CONTEXT);
                }),
              { discard: true }
            )
          )
        )
      );

      const harnessFor = (call: StepCall) =>
        opening.withPermits(1)(
          Effect.gen(function* openHarness() {
            const existing = (yield* Ref.get(open)).get(call.runId);

            if (existing !== undefined) {
              return { fresh: false, harness: existing } satisfies OpenRun;
            }

            const storage = yield* options.storageFor(call.runId);

            const harness = yield* pi(
              call,
              "open",
              async () =>
                await Harness.open(
                  storage,
                  { models: options.models, registry: options.registry },
                  BACKGROUND_CONTEXT
                )
            );

            yield* Ref.update(open, (harnesses) =>
              new Map(harnesses).set(call.runId, harness)
            );

            return { fresh: true, harness } satisfies OpenRun;
          }).pipe(Effect.withSpan("spawn.activate"))
        );

      const modelOf = (call: StepCall, agent: AgentConfig) => {
        const name = agent.model ?? "";
        const ref = options.modelRefs[name];

        return ref === undefined
          ? Effect.fail(
              new StepFailed({
                key: call.key,
                reason: `model "${name}" has no pi-durable mapping on this host. Mapped: ${Object.keys(options.modelRefs).join(", ") || "none"}. Add it to the Thinker's modelRefs or pick a mapped model in the plan`,
              })
            )
          : Effect.succeed(ref);
      };

      const conversationFor = (
        call: StepCall,
        harness: Harness,
        agent: AgentConfig
      ) =>
        Effect.gen(function* restore() {
          const model = yield* modelOf(call, agent);

          const root = yield* pi(
            call,
            "root",
            async () => await harness.root(BACKGROUND_CONTEXT)
          );

          const address = addressOf(call);

          const found = yield* pi(call, "map step", async () => {
            const before = await harness.snapshot(
              StepsDoc,
              root.id,
              BACKGROUND_CONTEXT
            );

            await root.commit(async (tx) => {
              const steps = await tx.doc(StepsDoc, root.id);

              if (steps.byAddress[address] === undefined) {
                const created = await tx.createConversation({
                  ownership: { kind: "ownerless" },
                });

                steps.byAddress[address] = created.id;
              }
            }, BACKGROUND_CONTEXT);

            const after = await harness.snapshot(
              StepsDoc,
              root.id,
              BACKGROUND_CONTEXT
            );

            return {
              created: before?.byAddress[address] === undefined,
              id: after?.byAddress[address],
            };
          });

          const conversation = yield* pi(call, "conversation", async () =>
            found.id === undefined
              ? undefined
              : await harness.conversation(found.id, BACKGROUND_CONTEXT)
          ).pipe(
            Effect.flatMap((value) =>
              value === undefined
                ? Effect.fail(
                    new StepFailed({
                      key: call.key,
                      reason: `conversation ${found.id} for ${address} is missing from the run's thinking store. The store was replaced or pruned; abort the run or restore the store`,
                    })
                  )
                : Effect.succeed(value)
            )
          );

          yield* pi(call, "configure", async () => {
            await conversation.configure(
              {
                extensions: [],
                model,
                thinkingLevel: agent.thinking ?? "low",
                tools: [],
              },
              BACKGROUND_CONTEXT
            );
          });

          return { conversation, created: found.created };
        }).pipe(Effect.withSpan("spawn.restore"));

      const firstToken = (
        call: StepCall,
        harness: Harness,
        conversation: Conversation
      ) =>
        Effect.gen(function* watch() {
          const seen = yield* Deferred.make<boolean>();

          const stream = yield* pi(
            call,
            "watch",
            async () =>
              await watchEvents(harness, conversation.id, BACKGROUND_CONTEXT)
          );

          // oxlint-disable-next-line require-await -- pi-durable listeners must return a Promise; this one only completes a Deferred.
          stream.start(async (events) => {
            if (
              events.some(
                (event) =>
                  event.type === "message_update" ||
                  event.type === "message_end"
              )
            ) {
              Deferred.doneUnsafe(seen, Effect.succeed(true));
            }
          });

          return { seen, stop: async () => await stream.stop() };
        });

      const answer = (call: StepCall, agent: AgentConfig, content: string) =>
        Effect.gen(function* firstTurn() {
          const { fresh, harness } = yield* harnessFor(call);

          const { conversation, created } = yield* conversationFor(
            call,
            harness,
            agent
          );

          const watching = yield* firstToken(call, harness, conversation);

          const settled = yield* Effect.gen(function* submitted() {
            const submission = yield* pi(
              call,
              "submit",
              async () =>
                await conversation.submit(
                  { content, requestId: addressOf(call), type: "input" },
                  BACKGROUND_CONTEXT
                )
            );

            yield* Effect.raceFirst(
              Deferred.await(watching.seen).pipe(
                Effect.withSpan("first_token")
              ),
              Effect.promise(
                async () => await submission.wait(BACKGROUND_CONTEXT)
              )
            );

            return yield* pi(
              call,
              "wait",
              async () => await submission.wait(BACKGROUND_CONTEXT)
            );
          }).pipe(
            Effect.ensuring(Effect.promise(async () => await watching.stop()))
          );

          if (settled.status !== "done" || settled.type !== "input") {
            return yield* new StepFailed({
              key: call.key,
              reason: `the model left the input unanswered (${"reason" in settled ? settled.reason : settled.status}). Check the model mapping and credentials, then resume the run`,
            });
          }

          const page = yield* pi(
            call,
            "read answer",
            async () =>
              await conversation.entries(
                { maxEntryId: settled.answer, minEntryId: settled.answer },
                1,
                undefined,
                BACKGROUND_CONTEXT
              )
          );

          const text = (page.items[0]?.model ?? [])
            .flatMap((message) =>
              message.role === "assistant" ? message.content : []
            )
            .flatMap((block) => (block.type === "text" ? [block.text] : []))
            .join("");

          const usage = yield* pi(
            call,
            "usage",
            async () =>
              await harness.snapshot(
                UsageDoc,
                conversation.id,
                BACKGROUND_CONTEXT
              )
          );

          const totals = Object.values(usage?.models ?? {});

          yield* Effect.annotateCurrentSpan({
            "cache.read": totals.reduce((sum, u) => sum + u.cacheRead, 0),
            "cache.write": totals.reduce((sum, u) => sum + u.cacheWrite, 0),
            respawn: fresh && !created,
          });

          return {
            text,
            tokens: totals.reduce((sum, u) => sum + u.totalTokens, 0),
            usd: totals.reduce((sum, u) => sum + u.cost.total, 0),
          } satisfies Answer;
        }).pipe(Effect.withSpan("first_turn"));

      return Thinker.of({
        decide: (call) =>
          answer(
            call,
            call.agent,
            `${call.question}\n\nAnswer with one JSON object and nothing else: {"choice": <one of ${JSON.stringify(call.options)}>, "confidence": <0 to 1>}.`
          ).pipe(
            Effect.map(({ text, tokens, usd }) => ({
              decision: Schema.decodeUnknownOption(DecisionSchema)(
                text.trim()
              ).pipe(
                Option.filter(({ choice }) => call.options.includes(choice))
              ),
              usage: { tokens, usd },
            }))
          ),
        elaborate: (call) =>
          Effect.fail(
            new StepFailed({
              key: call.key,
              reason:
                "elaborate is not wired on the pi-durable Thinker yet. Use think and judge steps, or run this plan on a host that wires elaborate",
            })
          ),
        think: (call) =>
          answer(call, call.agent, call.prompt).pipe(
            Effect.map(({ text, tokens }) => ({ output: text, tokens }))
          ),
      });
    })
  );
