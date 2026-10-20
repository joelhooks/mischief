// @effect-diagnostics nodeBuiltinImport:off asyncFunction:off -- The offline proof copies this fixture beside a legacy install and uses the same typed storage API under each version.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createSession,
  defineDoc,
  defineTask,
} from "@earendil-works/pi-durable";
import type { ConversationId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const [mode, file, expected] = process.argv.slice(2);

assert.ok(
  file !== undefined && file.length > 0,
  "Pass a SQLite file after the seed, verify or reject-v2 mode"
);

assert.ok(
  expected !== undefined && expected.length > 0,
  "Pass the expected-records JSON file after the SQLite file"
);

if (mode === "reject-v2") {
  await assert.rejects(
    openNodeSqliteStorage(file),
    /schema version 2 is newer than supported version 1/u
  );
} else {
  assert.ok(
    mode === "seed" || mode === "verify",
    "Use seed, verify or reject-v2"
  );

  const stepsDoc = defineDoc<{ byAddress: Record<string, ConversationId> }>({
    checkpointWhen: () => false,
    fork: "initial",
    history: "latest",
    initial: () => ({ byAddress: {} }),
    kind: "mischief.steps",
    scope: "conversation",
    version: 1,
  });

  const storage = await openNodeSqliteStorage(file);
  const session = createSession(storage);

  try {
    if (mode === "seed") {
      const task = defineTask<{ value: string }, { phase: "proof" }, string>({
        abort: async (_task, runtime, context) => {
          await runtime.commit(
            () => ({ outcome: { status: "aborted" }, status: "terminal" }),
            context
          );
        },
        initial: () => ({ phase: "proof" }),
        name: "upgrade.proof",
        phases: {
          proof: async (_task, runtime, context) => {
            await runtime.commit(
              () => ({
                outcome: { result: "proof complete", status: "completed" },
                status: "terminal",
              }),
              context
            );
          },
        },
        version: 1,
      });

      await session.commit(async (tx) => {
        const conversation = await tx.createConversation({
          ownership: { kind: "ownerless" },
        });

        await tx.appendEntry(conversation.id, {
          data: { text: "preserve this entry" },
          kind: "upgrade.proof",
        });
        await tx.createTask(
          task,
          { value: "preserve this task" },
          {
            conversationId: conversation.id,
            ownership: { kind: "conversation" },
          }
        );

        const steps = await tx.doc(stepsDoc, conversation.id);

        steps.byAddress["draft#1"] = conversation.id;
      }, BACKGROUND_CONTEXT);
    }

    const conversations = await storage.scanConversations(
      {},
      10,
      undefined,
      BACKGROUND_CONTEXT
    );

    const tasks = await storage.scanTasks(
      {},
      10,
      undefined,
      BACKGROUND_CONTEXT
    );

    const [conversation] = conversations.items;

    assert.ok(conversation);
    assert.equal(conversations.items.length, 1);
    assert.equal(tasks.items.length, 1);

    const entries = await storage.scanEntries(
      { conversationId: conversation.id },
      10,
      undefined,
      BACKGROUND_CONTEXT
    );

    const steps = await session.snapshot(
      stepsDoc,
      conversation.id,
      BACKGROUND_CONTEXT
    );

    assert.equal(entries.items.length, 1);
    assert.deepEqual(steps, { byAddress: { "draft#1": conversation.id } });

    const records = JSON.stringify({ conversations, entries, steps, tasks });

    if (mode === "seed") {
      await writeFile(expected, records);
    } else {
      assert.equal(records, await readFile(expected, "utf-8"));
    }
  } finally {
    await session.close(BACKGROUND_CONTEXT);
  }
}
