// @effect-diagnostics asyncFunction:off -- pi-durable commits and listeners take async callbacks at this adapter boundary.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai/models";
import type { Models } from "@earendil-works/pi-ai/models";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import {
  defineDoc,
  Harness,
  UsageDoc,
  watchEvents,
} from "@earendil-works/pi-durable";
import type {
  Conversation,
  ConversationId,
  ConversationStreamOptions,
  EntryId,
  HarnessOptions,
  HarnessSettings,
  ModelRef,
  ReportTask,
  SettledSubmissionRecord,
  Storage,
  SubmissionRecord,
} from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import type {
  AgentConfig,
  StepCall,
  ThinkingDeclaration,
  ThinkReceipt,
} from "@mischief/core";
import {
  DeclaredThinking,
  ProviderUnavailable,
  StepFailed,
  ThinkModelUnmapped,
  Thinker,
} from "@mischief/core";
import {
  Clock,
  Deferred,
  Effect,
  Layer,
  Option,
  Ref,
  Schema,
  Semaphore,
} from "effect";

import {
  causeOf,
  isTransportDrop,
  retryAfterOf,
  statusOf,
  verdictOf,
} from "./provider-status.js";
import type { ProviderVerdict } from "./provider-status.js";
import { receiptOf, requestedOf } from "./receipt.js";
import type { ThinkDefaults } from "./receipt.js";

const StepsDoc = defineDoc<{ byAddress: Record<string, ConversationId> }>({
  checkpointWhen: () => false,
  fork: "initial",
  history: "latest",
  initial: () => ({ byAddress: {} }),
  kind: "mischief.steps",
  scope: "conversation",
  version: 1,
});

export interface PiThinkerOptions {
  readonly declared?: ThinkingDeclaration;
  readonly defaults?: ThinkDefaults;
  readonly models: Models;
  readonly registry: HarnessOptions["registry"];
  readonly modelRefs: Readonly<Record<string, ModelRef>>;
  readonly storageFor: (runId: string) => Effect.Effect<Storage, StepFailed>;
  readonly streamFor?: (runId: string) => ConversationStreamOptions;
  readonly workspaceModelRef?:
    | ((agent: AgentConfig, model: ModelRef) => ModelRef)
    | undefined;
}

interface OpenRun {
  readonly harness: Harness;
  readonly fresh: boolean;
  readonly parked: Map<ConversationId, Deferred.Deferred<ReportTask>>;
}

const parkedFor = (
  parked: OpenRun["parked"],
  conversationId: ConversationId
) => {
  const existing = parked.get(conversationId);

  if (existing !== undefined) {
    return existing;
  }

  const signal = Deferred.makeUnsafe<ReportTask>();

  parked.set(conversationId, signal);

  return signal;
};

interface Answer {
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly receipt: ThinkReceipt;
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

const addressOf = (call: StepCall) =>
  call.epoch === 0
    ? `${call.key}#${call.visit}`
    : `${call.key}#${call.visit}@v${call.epoch}`;

const attemptId = (call: StepCall, attempt: number) =>
  attempt === 1 ? addressOf(call) : `${addressOf(call)}~${attempt}`;

const THINKER_OWNS_PROVIDER_RETRIES: HarnessSettings = {
  retry: { enabled: false },
};

interface Latest {
  readonly attempt: number;
  readonly record: SubmissionRecord | undefined;
}

interface ModelFailure {
  readonly message: string;
  readonly status: number | null;
  readonly transient: boolean;
}

const failureOf = (
  settled: SettledSubmissionRecord,
  messages: readonly AssistantMessage[]
): ModelFailure => {
  const failed = messages.find(({ stopReason }) => stopReason === "error");

  const message = failed?.errorMessage ?? settled.reason ?? "no error message";

  return {
    message,
    status: statusOf(message),
    transient:
      (failed !== undefined && isRetryableAssistantError(failed)) ||
      isTransportDrop(message),
  };
};

const thought = <R>(
  answered: Effect.Effect<
    Answer,
    StepFailed | ProviderUnavailable | ThinkModelUnmapped,
    R
  >
) =>
  answered.pipe(
    Effect.catchTag("ThinkModelUnmapped", ({ key, mapped, model }) =>
      Effect.fail(
        new StepFailed({
          key,
          reason: `model "${model}" has no pi-durable mapping on this host. Mapped: ${mapped.join(", ") || "none"}. Add it to the Thinker's modelRefs or pick a mapped model in the plan`,
        })
      )
    ),
    Effect.map(({ cacheRead, cacheWrite, receipt, text, tokens }) => ({
      cacheRead,
      cacheWrite,
      output: text,
      receipt,
      tokens,
    }))
  );

const thinkerOf = (options: PiThinkerOptions) =>
  Layer.effect(
    Thinker,
    Effect.gen(function* make() {
      const open = yield* Ref.make(new Map<string, OpenRun>());
      const opening = yield* Semaphore.make(1);

      yield* Effect.addFinalizer(() =>
        Ref.get(open).pipe(
          Effect.flatMap((harnesses) =>
            Effect.forEach(
              harnesses.values(),
              ({ harness }) =>
                Effect.promise(async () => {
                  await harness.close(BACKGROUND_CONTEXT);
                }),
              { discard: true }
            )
          )
        )
      );

      const settingsFor = (
        runId: string,
        parked: OpenRun["parked"]
      ): HarnessOptions => ({
        models: options.models,
        onReport: (_error, info) => {
          if (info.type === "task_parked") {
            Deferred.doneUnsafe(
              parkedFor(parked, info.task.conversationId),
              Effect.succeed(info.task)
            );
          }
        },
        registry: options.registry,
        settings:
          options.streamFor === undefined
            ? THINKER_OWNS_PROVIDER_RETRIES
            : {
                ...THINKER_OWNS_PROVIDER_RETRIES,
                stream: options.streamFor(runId),
              },
      });

      const openHarness = (
        call: StepCall,
        operation: string,
        storage: Storage
      ) =>
        Effect.gen(function* openingHarness() {
          const parked: OpenRun["parked"] = new Map();

          const harness = yield* pi(call, operation, async () => {
            const opened = await Harness.open(
              storage,
              settingsFor(call.runId, parked),
              BACKGROUND_CONTEXT
            );

            const inspection = await opened.inspect(BACKGROUND_CONTEXT);

            for (const { record, state } of inspection.tasks) {
              if (
                state.kind === "blocked" &&
                state.reason === "restart_limit"
              ) {
                Deferred.doneUnsafe(
                  parkedFor(parked, record.conversationId),
                  Effect.succeed({
                    conversationId: record.conversationId,
                    id: record.id,
                    kind: record.kind,
                  })
                );
              }
            }

            return opened;
          });

          return { fresh: true, harness, parked } satisfies OpenRun;
        });

      const unrecordedHarness = (call: StepCall) =>
        Effect.acquireRelease(
          openHarness(call, "open in memory", new MemoryStorage()),
          ({ harness }) =>
            Effect.promise(async () => {
              await harness.close(BACKGROUND_CONTEXT);
            })
        );

      const harnessFor = (call: StepCall) =>
        opening.withPermits(1)(
          Effect.gen(function* activateHarness() {
            const existing = (yield* Ref.get(open)).get(call.runId);

            if (existing !== undefined) {
              return { ...existing, fresh: false } satisfies OpenRun;
            }

            const storage = yield* options.storageFor(call.runId);

            const opened = yield* openHarness(call, "open", storage);

            yield* Ref.update(open, (harnesses) =>
              new Map(harnesses).set(call.runId, opened)
            );

            return opened;
          }).pipe(Effect.withSpan("spawn.activate"))
        );

      const modelOf = (
        call: StepCall,
        requested: ReturnType<typeof requestedOf>
      ) => {
        const name = requested.model;
        const ref = options.modelRefs[name];

        if (
          requested.agent.workspace !== undefined &&
          options.workspaceModelRef === undefined
        ) {
          return Effect.fail(
            new StepFailed({
              key: call.key,
              reason:
                "agent.workspace has no enabled bridge route on this host. Set MISCHIEF_WORKSPACE=on and configure MISCHIEF_WORKSPACE_BRIDGE_URL and MISCHIEF_WORKSPACE_BRIDGE_KEY, or remove agent.workspace and its shell tools",
            })
          );
        }

        return ref === undefined
          ? Effect.fail(
              new ThinkModelUnmapped({
                key: call.key,
                mapped: Object.keys(options.modelRefs),
                model: name,
              })
            )
          : Effect.succeed(
              requested.agent.workspace === undefined
                ? ref
                : (options.workspaceModelRef?.(requested.agent, ref) ?? ref)
            );
      };

      const conversationFor = (
        call: StepCall,
        harness: Harness,
        requested: ReturnType<typeof requestedOf>
      ) =>
        Effect.gen(function* restore() {
          const model = yield* modelOf(call, requested);

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
                thinkingLevel: requested.thinking,
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

          stream.start(async (events) => {
            if (
              events.some(
                (event) =>
                  event.type === "message_update" ||
                  event.type === "message_end"
              )
            ) {
              Deferred.doneUnsafe(seen, Effect.succeed(true));
              await stream.stop();
            }
          });

          return { seen, stop: async () => await stream.stop() };
        });

      const latestOf = (call: StepCall, conversation: Conversation) =>
        pi(
          call,
          "find attempt",
          async () =>
            await conversation.commit(async (tx) => {
              const probe = async (attempt: number): Promise<Latest> => {
                const next = await tx.submissionByRequest(
                  conversation.id,
                  attemptId(call, attempt + 1)
                );

                return next === undefined
                  ? {
                      attempt,
                      record: await tx.submissionByRequest(
                        conversation.id,
                        attemptId(call, attempt)
                      ),
                    }
                  : await probe(attempt + 1);
              };

              return await probe(1);
            }, BACKGROUND_CONTEXT)
        );

      const failedMessagesOf = (
        call: StepCall,
        conversation: Conversation,
        { entry }: SettledSubmissionRecord
      ) =>
        entry === undefined
          ? Effect.succeed([])
          : pi(call, "read failure", async () => {
              const page = await conversation.entries(
                { minEntryId: entry },
                20,
                undefined,
                BACKGROUND_CONTEXT
              );

              return page.items.flatMap((item) =>
                (item.model ?? []).flatMap((message) =>
                  message.role === "assistant" ? [message] : []
                )
              );
            });

      const settle = (
        call: StepCall,
        conversation: Conversation,
        model: ModelRef,
        attempt: { readonly n: number; readonly fresh: boolean },
        content: string,
        seen: Deferred.Deferred<boolean>,
        retried: boolean
      ): Effect.Effect<EntryId, StepFailed | ProviderUnavailable> =>
        Effect.gen(function* submitted() {
          if (attempt.fresh && attempt.n > 1) {
            yield* pi(call, "reset", async () => {
              await conversation.reset(undefined, BACKGROUND_CONTEXT);
            });
          }

          const submission = yield* pi(
            call,
            "submit",
            async () =>
              await conversation.submit(
                {
                  content,
                  requestId: attemptId(call, attempt.n),
                  type: "input",
                },
                BACKGROUND_CONTEXT
              )
          );

          yield* Effect.raceFirst(
            Deferred.await(seen).pipe(Effect.withSpan("first_token")),
            pi(
              call,
              "wait for first token",
              async () => await submission.wait(BACKGROUND_CONTEXT)
            )
          );

          const settled = yield* pi(
            call,
            "wait",
            async () => await submission.wait(BACKGROUND_CONTEXT)
          );

          if (settled.status === "done" && settled.type === "input") {
            return settled.answer;
          }

          if (
            settled.status !== "unanswered" ||
            settled.reason !== "model_error"
          ) {
            return yield* new StepFailed({
              key: call.key,
              reason: `the model left the input unanswered (${settled.status === "unanswered" ? settled.reason : settled.status}). Check the model mapping and credentials, then resume the run`,
            });
          }

          const failure = failureOf(
            settled,
            yield* failedMessagesOf(call, conversation, settled)
          );

          const held = new ProviderUnavailable({
            cause: causeOf(failure.status),
            error: failure.message,
            key: call.key,
            provider: `${model.provider}/${model.modelId}`,
            retryAfter: retryAfterOf(
              failure.message,
              failure.status,
              yield* Clock.currentTimeMillis
            ),
            status: failure.status,
          });

          const outcomes: Readonly<
            Record<
              ProviderVerdict,
              () => Effect.Effect<EntryId, StepFailed | ProviderUnavailable>
            >
          > = {
            fail: () =>
              Effect.fail(
                new StepFailed({
                  key: call.key,
                  reason: `the model proxy refused the think with ${failure.status === null ? "no HTTP status" : `HTTP ${failure.status}`}: ${failure.message}. Check the request, the model mapping (${model.provider}/${model.modelId}) and the key binding, then resume the run`,
                })
              ),
            hold: () => Effect.fail(held),
            retryThenHold: () =>
              retried || held.retryAfter !== undefined
                ? Effect.fail(held)
                : settle(
                    call,
                    conversation,
                    model,
                    { fresh: true, n: attempt.n + 1 },
                    content,
                    seen,
                    true
                  ),
          };

          return yield* outcomes[
            verdictOf(failure.status, failure.transient)
          ]();
        });

      const answer = <R>(
        call: StepCall,
        requested: ReturnType<typeof requestedOf>,
        content: string,
        opened: Effect.Effect<OpenRun, StepFailed, R>
      ) =>
        Effect.gen(function* firstTurn() {
          const { fresh, harness, parked } = yield* opened;

          const { conversation, created } = yield* conversationFor(
            call,
            harness,
            requested
          );

          const model = yield* modelOf(call, requested);

          const watching = yield* firstToken(call, harness, conversation);

          const latest = yield* latestOf(call, conversation);

          const resumed = latest.record?.status === "unanswered";

          const answered = yield* Effect.raceFirst(
            settle(
              call,
              conversation,
              model,
              {
                fresh: resumed,
                n: resumed ? latest.attempt + 1 : latest.attempt,
              },
              content,
              watching.seen,
              false
            ),
            Deferred.await(parkedFor(parked, conversation.id)).pipe(
              Effect.flatMap((task) =>
                Effect.fail(
                  new StepFailed({
                    key: call.key,
                    reason: `pi-durable task ${task.id} (${task.kind}) is parked: restart_limit after repeated crashes without progress. The think cannot finish while parked. Inspect the run with inspectRun; fix the crash cause, then abort the run and submit a new run`,
                  })
                )
              )
            )
          ).pipe(
            Effect.ensuring(Effect.promise(async () => await watching.stop()))
          );

          const page = yield* pi(
            call,
            "read answer",
            async () =>
              await conversation.entries(
                { maxEntryId: answered, minEntryId: answered },
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

          const served = options.models.getModel(model.provider, model.modelId);

          const receipt = receiptOf(
            requested,
            model.modelId,
            served === undefined
              ? requested.thinking
              : clampThinkingLevel(served, requested.thinking),
            page.items[0]?.model
          );

          yield* Effect.logInfo("mischief.think").pipe(
            Effect.annotateLogs({
              key: call.key,
              receipt: JSON.stringify(receipt),
              runId: call.runId,
            })
          );

          return {
            cacheRead: totals.reduce((sum, u) => sum + u.cacheRead, 0),
            cacheWrite: totals.reduce((sum, u) => sum + u.cacheWrite, 0),
            receipt,
            text,
            tokens: totals.reduce((sum, u) => sum + u.totalTokens, 0),
            usd: totals.reduce((sum, u) => sum + u.cost.total, 0),
          } satisfies Answer;
        }).pipe(Effect.withSpan("first_turn"));

      return Thinker.of({
        decide: (call) =>
          answer(
            call,
            requestedOf(call.agent, options.defaults, call.ceiling),
            `${call.question}\n\nAnswer with one JSON object and nothing else: {"choice": <one of ${JSON.stringify(call.options)}>, "confidence": <0 to 1>}.`,
            harnessFor(call)
          ).pipe(
            Effect.map(({ receipt, text, tokens, usd }) => ({
              decision: Schema.decodeUnknownOption(DecisionSchema)(
                text.trim()
              ).pipe(
                Option.filter(({ choice }) => call.options.includes(choice))
              ),
              usage: { receipt, tokens, usd },
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
          answer(
            call,
            requestedOf(call.agent, options.defaults, call.ceiling),
            call.prompt,
            harnessFor(call)
          ).pipe(thought),
        thinkUnrecorded: (call) =>
          answer(
            call,
            requestedOf(call.agent, options.defaults, call.ceiling),
            call.prompt,
            unrecordedHarness(call)
          ).pipe(thought, Effect.scoped),
      });
    })
  );

export const piThinker = (options: PiThinkerOptions) =>
  Layer.merge(
    thinkerOf(options),
    Layer.succeed(
      DeclaredThinking,
      options.declared ?? {
        fallback: options.defaults?.thinking ?? "low",
        models: {},
      }
    )
  );
