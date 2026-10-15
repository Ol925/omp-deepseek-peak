declare module "bun:sqlite" {
  export interface Statement {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  }

  export class Database {
    constructor(
      path: string,
      options?: { readonly?: boolean; create?: boolean; readOnly?: boolean },
    );
    prepare(sql: string): Statement;
    query(sql: string): Statement;
    close(): void;
  }

  export const DatabaseSync: typeof Database;
}
