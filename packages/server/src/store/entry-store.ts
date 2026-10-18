import type { Driver, Row } from './types.js';

/**
 * Entries — the short notes a person leaves along the way (what they solved, learned, where they were in the flow).
 * They outlive cards: clearing or deleting a card never deletes them. The browser seals { kind, text, goal, where it was
 * written } with the account key (AAD = entry:<id>); the server knows only when it was written and which card it
 * belongs to (session_key — the server knows session keys anyway), so it can hand back a card's entries.
 * Which goal an entry belongs to stays sealed, like goal membership.
 */
export const ENTRY_SCHEMA = `
CREATE TABLE IF NOT EXISTS entries (
  id          TEXT NOT NULL,
  account_id  TEXT NOT NULL,
  session_key TEXT,
  data        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (account_id, id)
);
CREATE INDEX IF NOT EXISTS entries_time ON entries(account_id, created_at);
CREATE INDEX IF NOT EXISTS entries_session ON entries(account_id, session_key, created_at);
`;

export interface Entry {
  id: string;
  /** The card it was written on (absent: written in the journal or on a goal) */
  sessionKey?: string;
  /** Sealed { kind, text, goalId, context } (AAD = entry:<id>) */
  data: string;
  createdAt: string;
  updatedAt: string;
}

export type EntryChange = { accountId: string } & ({ type: 'entry'; entry: Entry } | { type: 'entry-removed'; id: string });

/** Max entries per account — years of a few a day */
export const MAX_ENTRIES = 50_000;

const toEntry = (r: Row): Entry => ({
  id: r.id as string,
  sessionKey: (r.session_key as string | null) ?? undefined,
  data: r.data as string,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

export class EntryStore {
  private readonly listeners = new Set<(c: EntryChange) => void>();

  constructor(private readonly db: Driver) {}

  subscribe(fn: (c: EntryChange) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(c: EntryChange) {
    for (const l of this.listeners) l(c);
  }

  /**
   * Newest first. session: only that card's entries. since/before: written at or after / strictly before (paging back).
   */
  async list(accountId: string, opts: { session?: string; since?: string; before?: string; limit?: number } = {}): Promise<Entry[]> {
    const where = ['account_id = ?'];
    const params: unknown[] = [accountId];
    if (opts.session !== undefined) {
      where.push('session_key = ?');
      params.push(opts.session);
    }
    if (opts.since) {
      where.push('created_at >= ?');
      params.push(opts.since);
    }
    if (opts.before) {
      where.push('created_at < ?');
      params.push(opts.before);
    }
    params.push(Math.min(Math.max(opts.limit ?? 200, 1), 1000));
    const { rows } = await this.db.query(`SELECT * FROM entries WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`, params);
    return rows.map(toEntry);
  }

  /** The browser picks the id (it is part of the seal's AAD). undefined if it exists or the limit is reached */
  async create(accountId: string, id: string, data: string, sessionKey?: string, at = new Date().toISOString()): Promise<Entry | undefined> {
    const created = await this.db.transaction(async (q) => {
      const { rows } = await q('SELECT COUNT(*) AS n, SUM(CASE WHEN id = ? THEN 1 ELSE 0 END) AS dup FROM entries WHERE account_id = ?', [id, accountId]);
      if (Number(rows[0]?.n ?? 0) >= MAX_ENTRIES || Number(rows[0]?.dup ?? 0) > 0) return false;
      await q('INSERT INTO entries (id, account_id, session_key, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
        id,
        accountId,
        sessionKey ?? null,
        data,
        at,
        at,
      ]);
      return true;
    });
    if (!created) return undefined;
    const entry: Entry = { id, ...(sessionKey ? { sessionKey } : {}), data, createdAt: at, updatedAt: at };
    this.emit({ accountId, type: 'entry', entry });
    return entry;
  }

  /** Rewrites the sealed content. The time it was written never changes */
  async update(accountId: string, id: string, data: string): Promise<Entry | undefined> {
    const at = new Date().toISOString();
    const entry = await this.db.transaction(async (q) => {
      const { changes } = await q('UPDATE entries SET data = ?, updated_at = ? WHERE account_id = ? AND id = ?', [data, at, accountId, id]);
      if (!changes) return undefined;
      const { rows } = await q('SELECT * FROM entries WHERE account_id = ? AND id = ?', [accountId, id]);
      return rows[0] ? toEntry(rows[0]) : undefined;
    });
    if (entry) this.emit({ accountId, type: 'entry', entry });
    return entry;
  }

  async delete(accountId: string, id: string): Promise<boolean> {
    const ok = await this.db.transaction(async (q) => (await q('DELETE FROM entries WHERE account_id = ? AND id = ?', [accountId, id])).changes > 0);
    if (ok) this.emit({ accountId, type: 'entry-removed', id });
    return ok;
  }
}
