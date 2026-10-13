import type { SqlStorage } from "@mischief/plan-run";

export const TOKENS =
  "CREATE TABLE IF NOT EXISTS tokens (jti TEXT PRIMARY KEY, exp INTEGER NOT NULL)";

export interface Spend {
  readonly durable: boolean;
  readonly exp: number;
  readonly jti: string;
  readonly now: number;
}

export const spendToken = (
  storage: SqlStorage,
  memory: Map<string, number>,
  { durable, exp, jti, now }: Spend
) => {
  for (const [held, until] of memory) {
    if (until < now) {
      memory.delete(held);
    }
  }

  if (!durable) {
    const seen =
      memory.has(jti) ||
      storage.sql
        .exec("SELECT jti FROM tokens WHERE jti = ? AND exp >= ?", jti, now)
        .toArray().length > 0;

    if (!seen) {
      memory.set(jti, exp);
    }

    return !seen;
  }

  return storage.transactionSync(() => {
    storage.sql.exec("DELETE FROM tokens WHERE exp < ?", now);

    const seen =
      memory.has(jti) ||
      storage.sql
        .exec("SELECT jti FROM tokens WHERE jti = ? AND exp >= ?", jti, now)
        .toArray().length > 0;

    if (!seen) {
      storage.sql.exec("INSERT INTO tokens (jti, exp) VALUES (?, ?)", jti, exp);
    }

    return !seen;
  });
};
