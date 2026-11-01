import type { SqlStorage, SqlValue } from "@mischief/plan-run";
import { Effect } from "effect";

export interface Cut {
  readonly at: number;
  seen: number;
  tripped: string | null;
  landed: number;
}

export const cutAt = (at: number): Cut => ({
  at,
  landed: 0,
  seen: 0,
  tripped: null,
});

export const neverCut = () => cutAt(Number.POSITIVE_INFINITY);

export const reaches = (cut: Cut, label: string) => {
  if (cut.tripped !== null) {
    return true;
  }

  cut.seen += 1;

  if (cut.seen === cut.at) {
    cut.tripped = label;

    return true;
  }

  return false;
};

export const cutEffect = <A, E>(
  cut: Cut,
  label: string,
  work: Effect.Effect<A, E>
): Effect.Effect<A, E> =>
  Effect.suspend(() => (reaches(cut, label) ? Effect.never : work));

const READ =
  /^\s*(?:SELECT|PRAGMA|CREATE (?:TABLE|INDEX|UNIQUE INDEX) IF NOT EXISTS)\b/iu;

export const frozenAfterCut = (storage: SqlStorage, cut: Cut): SqlStorage => ({
  sql: {
    exec: (query: string, ...bindings: SqlValue[]) => {
      if (cut.tripped !== null) {
        throw new Error(
          `the turn was cut at ${cut.tripped}; nothing after the cut reaches storage`
        );
      }

      if (!READ.test(query)) {
        cut.landed += 1;
      }

      return storage.sql.exec(query, ...bindings);
    },
  },
  transactionSync: (closure) => {
    if (cut.tripped !== null) {
      throw new Error(
        `the turn was cut at ${cut.tripped}; nothing after the cut reaches storage`
      );
    }

    return storage.transactionSync(closure);
  },
});

export interface AlarmClock {
  pending: number | null;
}
