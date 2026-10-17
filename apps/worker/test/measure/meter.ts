// @effect-diagnostics asyncFunction:off -- the meter wraps DurableObjectStorage.transaction, whose callback and result are Promises.
import { Option, Schema } from "effect";

export type CommitKind = "sync" | "async" | "bare";

export interface Commit {
  readonly bytes: number;
  readonly kind: CommitKind;
  readonly largestValue: number;
  readonly refused: string | null;
  readonly statements: number;
  readonly tables: Record<string, number>;
}

export interface RunStateParts {
  readonly mailbox: number;
  readonly mailboxEvents: number;
  readonly pending: number;
  readonly snapshot: number;
  readonly state: number;
}

interface Frame {
  bytes: number;
  largestValue: number;
  refused: string | null;
  statements: number;
  readonly tables: Map<string, number>;
}

type Binding = ArrayBuffer | ArrayBufferView | string | number | null;

const WRITE =
  /^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(?<table>\w+)/iu;

const encoder = new TextEncoder();

const isText = Schema.is(Schema.String);

const sizeOf = (value: Binding) => {
  if (value === null) {
    return 0;
  }

  if (isText(value)) {
    return encoder.encode(value).byteLength;
  }

  return value instanceof ArrayBuffer || ArrayBuffer.isView(value)
    ? value.byteLength
    : 8;
};

const StoredState = Schema.fromJsonString(
  Schema.Struct({
    checkpoint: Schema.NullOr(
      Schema.Struct({
        mailbox: Schema.Array(Schema.Json),
        pending: Schema.Json,
        snapshot: Schema.Json,
      })
    ),
  })
);

const decodeStoredState = Schema.decodeUnknownOption(StoredState);

const jsonBytes = (value: Schema.Json) =>
  encoder.encode(JSON.stringify(value)).byteLength;

const partsOf = (text: string): RunStateParts => {
  const checkpoint = decodeStoredState(text).pipe(
    Option.flatMap(({ checkpoint: stored }) => Option.fromNullOr(stored))
  );

  return Option.match(checkpoint, {
    onNone: () => ({
      mailbox: 0,
      mailboxEvents: 0,
      pending: 0,
      snapshot: 0,
      state: encoder.encode(text).byteLength,
    }),
    onSome: ({ mailbox, pending, snapshot }) => ({
      mailbox: jsonBytes(mailbox),
      mailboxEvents: mailbox.length,
      pending: jsonBytes(pending),
      snapshot: jsonBytes(snapshot),
      state: encoder.encode(text).byteLength,
    }),
  });
};

export const commits: Commit[] = [];

export const runStates: RunStateParts[] = [];

const frame = (): Frame => ({
  bytes: 0,
  largestValue: 0,
  refused: null,
  statements: 0,
  tables: new Map(),
});

const seal = (open: Frame, kind: CommitKind) => {
  if (open.statements > 0) {
    commits.push({
      bytes: open.bytes,
      kind,
      largestValue: open.largestValue,
      refused: open.refused,
      statements: open.statements,
      tables: Object.fromEntries(open.tables),
    });
  }
};

export const meterStorage = (storage: DurableObjectStorage) => {
  const frames: Frame[] = [];
  const { sql } = storage;
  const exec = sql.exec.bind(sql);
  const transactionSync = storage.transactionSync.bind(storage);
  const transaction = storage.transaction.bind(storage);

  const record = (query: string, bindings: readonly Binding[]) => {
    const table = WRITE.exec(query)?.groups?.table;

    if (table === undefined) {
      return null;
    }

    const sizes = bindings.map(sizeOf);
    const bytes = sizes.reduce((sum, size) => sum + size, 0);
    const open = frames.at(-1) ?? frame();

    open.bytes += bytes;
    open.statements += 1;
    open.largestValue = Math.max(open.largestValue, ...sizes);
    open.tables.set(table, (open.tables.get(table) ?? 0) + bytes);

    const [, state] = bindings;

    if (table === "mischief_runs" && isText(state)) {
      runStates.push(partsOf(state));
    }

    return open;
  };

  const refuse = (open: Frame | null, reason: string) => {
    const target = frames.at(-1) ?? open;

    if (target !== null) {
      target.refused ??= reason;
    }
  };

  const leave = (open: Frame, kind: CommitKind) => {
    frames.splice(frames.indexOf(open), 1);
    seal(open, kind);
  };

  const meteredExec = <T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: Binding[]
  ): SqlStorageCursor<T> => {
    const open = record(query, bindings);

    try {
      return exec<T>(query, ...bindings);
    } catch (error) {
      refuse(open, String(error));
      throw error;
    } finally {
      if (open !== null && frames.length === 0) {
        seal(open, "bare");
      }
    }
  };

  const meteredTransactionSync = <T>(closure: () => T): T => {
    const open = frame();

    frames.push(open);

    try {
      return transactionSync(closure);
    } catch (error) {
      refuse(open, String(error));
      throw error;
    } finally {
      leave(open, "sync");
    }
  };

  const meteredTransaction = async <T>(
    closure: (txn: DurableObjectTransaction) => Promise<T>
  ): Promise<T> => {
    const open = frame();

    frames.push(open);

    try {
      return await transaction(closure);
    } catch (error) {
      refuse(open, String(error));
      throw error;
    } finally {
      leave(open, "async");
    }
  };

  Object.defineProperty(sql, "exec", { value: meteredExec });
  Object.defineProperty(storage, "sql", { value: sql });
  Object.defineProperty(storage, "transactionSync", {
    value: meteredTransactionSync,
  });
  Object.defineProperty(storage, "transaction", { value: meteredTransaction });

  return storage;
};
