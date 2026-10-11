export type SqlValue = ArrayBuffer | string | number | null;

export type SqlRow = Record<string, SqlValue>;

export interface SqlStorage {
  readonly sql: {
    readonly exec: (
      query: string,
      ...bindings: SqlValue[]
    ) => { readonly toArray: () => SqlRow[] };
  };
  readonly transactionSync: <T>(closure: () => T) => T;
}
