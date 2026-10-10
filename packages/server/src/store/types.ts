import type { Sealed, StoredSession, StoredTimelineItem, StoredTurn, WireRecord } from '@bitl/shared';

/** The only account in local mode. In cloud mode, the signed-in account id */
export const LOCAL_ACCOUNT = 'local';

/** A change notified to subscribers, tagged with its account — SSE sends only the subscriber's own account */
export type StoreChange =
  /** prevStatus: status before the change (absent for a new session) — notifications fire only "the moment it turns waiting for you" */
  | { type: 'session'; accountId: string; session: StoredSession; prevStatus?: StoredSession['status'] }
  | { type: 'removed'; accountId: string; key: string };

/** User-editable fields. The note is encrypted by the browser (null clears it) */
export interface SessionEdit {
  pinned?: boolean;
  archived?: boolean;
  note?: Sealed | null;
}

export interface ListOptions {
  includeEnded?: boolean;
  includeArchived?: boolean;
}

/**
 * Session store. SQLite in local mode, Postgres in cloud mode (same implementation, only the driver differs).
 * Every read and write is scoped to an account — no method reaches another account's data without an accountId.
 * (sweepStale/pruneEvents are server maintenance and apply to all accounts)
 */
export interface SessionStore {
  ingest(accountId: string, rec: WireRecord): Promise<StoredSession>;
  getSession(accountId: string, key: string): Promise<StoredSession | undefined>;
  listSessions(accountId: string, opts?: ListOptions): Promise<StoredSession[]>;
  listTurns(accountId: string, key: string, limit?: number): Promise<StoredTurn[]>;
  listTimeline(accountId: string, key: string, limit?: number): Promise<StoredTimelineItem[]>;
  editSession(accountId: string, key: string, edit: SessionEdit): Promise<StoredSession | undefined>;
  acknowledge(accountId: string, key: string, now?: Date): Promise<StoredSession | undefined>;
  /** Deletes a session with all its turns and events. true if deleted */
  deleteSession(accountId: string, key: string): Promise<boolean>;
  /** Bulk-deletes ended cards (only among keys, if given). Returns the count */
  deleteEnded(accountId: string, keys?: string[]): Promise<number>;
  /** Marks long-silent running sessions stale (all accounts). Returns the count */
  sweepStale(now?: Date): Promise<number>;
  /** Deletes old raw events (all accounts; session/turn summaries are kept). Returns the count */
  pruneEvents(olderThan: Date): Promise<number>;
  subscribe(fn: (change: StoreChange) => void): () => void;
  close(): Promise<void>;
  /** Where the old-format DB was moved (SQLite; reported in the startup log if set) */
  readonly backupPath?: string;
}

// ── Driver: hides only SQL dialect differences ──────────────────────────────

export type Row = Record<string, unknown>;
export type Query = (sql: string, params?: unknown[]) => Promise<{ rows: Row[]; changes: number }>;

export interface Driver {
  readonly dialect: 'sqlite' | 'postgres';
  /** SQL uses ? placeholders (the Postgres driver rewrites them to $1…) */
  query: Query;
  /**
   * Transaction. With lockKey, transactions sharing that key run in order (Postgres: advisory lock).
   * So concurrent events for the same session don't lose updates.
   */
  transaction<T>(fn: (q: Query) => Promise<T>, lockKey?: string): Promise<T>;
  close(): Promise<void>;
}
