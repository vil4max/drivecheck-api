// The few Node built-ins the tests read files with; declared here so the project needs no
// @types/node (no new dependency, spec 002 D5).
interface ImportMeta {
  readonly url: string;
}

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function readFileSync(path: string): Uint8Array;
  export function existsSync(path: string): boolean;
}

declare module "node:path" {
  export function dirname(path: string): string;
  export function resolve(...paths: string[]): string;
}

// SQLite in memory, so the push registry's SQL runs in tests as the Durable Object runs it.
declare module "node:sqlite" {
  export class StatementSync {
    all(...params: unknown[]): Record<string, unknown>[];
    run(...params: unknown[]): { changes: number | bigint };
  }
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}
