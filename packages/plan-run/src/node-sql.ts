import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue, SQLOutputValue } from "node:sqlite";

import { Schema } from "effect";

import type { SqlRow, SqlStorage, SqlValue } from "./sql.js";

const binding = (value: SqlValue): SQLInputValue =>
  value instanceof ArrayBuffer ? new Uint8Array(value) : value;

const cell = (value: SQLOutputValue): SqlValue => {
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(
      value.buffer,
      value.byteOffset,
      value.byteLength
    ).slice().buffer;
  }

  if (Schema.is(Schema.BigInt)(value)) {
    return Number(value);
  }

  return value;
};

export const nodeSqlStorage = (file: string): SqlStorage => {
  const database = new DatabaseSync(file);

  const exec = (query: string, ...bindings: SqlValue[]) => {
    const statement = database.prepare(query);

    const rest = query
      .slice(query.indexOf(statement.sourceSQL) + statement.sourceSQL.length)
      .trim();

    if (rest !== "" && bindings.length === 0) {
      database.exec(query);

      return { toArray: (): SqlRow[] => [] };
    }

    const found = statement.all(...bindings.map(binding));

    return {
      toArray: (): SqlRow[] =>
        found.map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([name, value]) => [name, cell(value)])
          )
        ),
    };
  };

  return {
    sql: { exec },
    transactionSync: (closure) => {
      database.exec("BEGIN");

      try {
        const result = closure();

        database.exec("COMMIT");

        return result;
      } catch (error) {
        database.exec("ROLLBACK");

        throw error;
      }
    },
  };
};
