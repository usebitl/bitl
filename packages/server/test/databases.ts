import { openSqliteStore, type SqlStore } from '../src/store/index.js';

/**
 * Which DBs the store tests run against. SQLite (local mode) by default.
 * To add another store, push it onto this array in vitest setupFiles — the same tests then run on that DB too.
 */
export const DATABASES: [name: string, open: () => Promise<SqlStore>][] = [['sqlite', async () => openSqliteStore(':memory:')]];

/** DBs added only to the store contract tests (e.g. a real server wiped per test) */
export const CONTRACT_DATABASES: [name: string, open: () => Promise<SqlStore>][] = [];
