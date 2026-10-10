import type { Driver, Row } from './types.js';

/**
 * Goals — group several agent cards under one purpose a person defines (e.g. "urgent deploy today").
 * The browser seals the title and linked card list together with the account key (AAD = goal:<id>).
 * The server only knows how many goals exist and when they changed, not which cards belong to which goal.
 * Concurrent edits from several devices are guarded by version (stale version → 409 + latest goal).
 */
export const GOAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS goals (
  id          TEXT NOT NULL,
  account_id  TEXT NOT NULL,
  data        TEXT NOT NULL,
  version     INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  closed_at   TEXT,
  PRIMARY KEY (account_id, id)
);
`;

export interface Goal {
  id: string;
  /** Sealed { title, members } (AAD = goal:<id>) */
  data: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Closed goal (drops out of the goal bar) */
  closedAt?: string;
}

export type GoalChange = { accountId: string } & ({ type: 'goal'; goal: Goal } | { type: 'goal-removed'; id: string });

/** Max goals per account (including closed ones) — so they don't pile up forever */
export const MAX_GOALS = 500;

const toGoal = (r: Row): Goal => ({
  id: r.id as string,
  data: r.data as string,
  version: Number(r.version),
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
  closedAt: (r.closed_at as string | null) ?? undefined,
});

const now = () => new Date().toISOString();

export class GoalStore {
  private readonly listeners = new Set<(c: GoalChange) => void>();

  constructor(private readonly db: Driver) {}

  subscribe(fn: (c: GoalChange) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(c: GoalChange) {
    for (const l of this.listeners) l(c);
  }

  /** includeClosed: include closed goals */
  async list(accountId: string, includeClosed = false): Promise<Goal[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM goals WHERE account_id = ?${includeClosed ? '' : ' AND closed_at IS NULL'} ORDER BY created_at`,
      [accountId],
    );
    return rows.map(toGoal);
  }

  async get(accountId: string, id: string): Promise<Goal | undefined> {
    const { rows } = await this.db.query('SELECT * FROM goals WHERE account_id = ? AND id = ?', [accountId, id]);
    return rows[0] ? toGoal(rows[0]) : undefined;
  }

  /** The browser picks the id (it's part of the seal's AAD, so it must be known before sending). undefined if it exists or the limit is reached */
  async create(accountId: string, id: string, data: string): Promise<Goal | undefined> {
    const at = now();
    const created = await this.db.transaction(async (q) => {
      const { rows } = await q('SELECT COUNT(*) AS n, SUM(CASE WHEN id = ? THEN 1 ELSE 0 END) AS dup FROM goals WHERE account_id = ?', [id, accountId]);
      if (Number(rows[0]?.n ?? 0) >= MAX_GOALS || Number(rows[0]?.dup ?? 0) > 0) return false;
      await q('INSERT INTO goals (id, account_id, data, version, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)', [id, accountId, data, at, at]);
      return true;
    });
    if (!created) return undefined;
    const goal: Goal = { id, data, version: 1, createdAt: at, updatedAt: at };
    this.emit({ accountId, type: 'goal', goal });
    return goal;
  }

  /**
   * Edit. If version differs (another device edited first), nothing changes and the latest goal is returned as conflict.
   * Only the given fields among data/closed change.
   */
  async update(
    accountId: string,
    id: string,
    version: number,
    edit: { data?: string; closed?: boolean },
  ): Promise<{ goal: Goal } | { conflict: Goal } | undefined> {
    const at = now();
    const result = await this.db.transaction(async (q): Promise<{ goal: Goal } | { conflict: Goal } | undefined> => {
      const { rows } = await q('SELECT * FROM goals WHERE account_id = ? AND id = ?', [accountId, id]);
      if (!rows[0]) return undefined;
      const current = toGoal(rows[0]);
      if (current.version !== version) return { conflict: current };
      const data = edit.data ?? current.data;
      const closedAt = edit.closed === undefined ? (current.closedAt ?? null) : edit.closed ? (current.closedAt ?? at) : null;
      await q('UPDATE goals SET data = ?, closed_at = ?, version = ?, updated_at = ? WHERE account_id = ? AND id = ?', [
        data,
        closedAt,
        version + 1,
        at,
        accountId,
        id,
      ]);
      return { goal: { ...current, data, version: version + 1, updatedAt: at, closedAt: closedAt ?? undefined } };
    });
    if (result && 'goal' in result) this.emit({ accountId, type: 'goal', goal: result.goal });
    return result;
  }

  async delete(accountId: string, id: string): Promise<boolean> {
    const ok = await this.db.transaction(async (q) => (await q('DELETE FROM goals WHERE account_id = ? AND id = ?', [accountId, id])).changes > 0);
    if (ok) this.emit({ accountId, type: 'goal-removed', id });
    return ok;
  }
}
