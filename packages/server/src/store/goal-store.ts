import type { Driver, Row } from './types.js';

/**
 * 목표 — 여러 에이전트 카드를 사람이 정한 목적 하나로 묶는다 (예: "오늘 긴급 배포").
 * 제목과 연결한 카드 목록은 브라우저가 계정 키로 한 덩어리로 봉인해 보낸다 (AAD = goal:<id>).
 * 서버는 목표가 몇 개 있고 언제 바뀌었는지만 알고, 어떤 카드들이 한 목표인지는 모른다.
 * 여러 기기가 동시에 고치면 version 으로 막는다 (낡은 version 이면 409 + 최신 목표).
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
  /** 봉인된 { title, members } (AAD = goal:<id>) */
  data: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** 마친 목표 (목표 줄에서 빠진다) */
  closedAt?: string;
}

export type GoalChange = { accountId: string } & ({ type: 'goal'; goal: Goal } | { type: 'goal-removed'; id: string });

/** 계정당 목표 수 상한 (마친 목표 포함) — 무한히 쌓이지 않게 */
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

  /** includeClosed: 마친 목표도 */
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

  /** id 는 브라우저가 정한다 (봉인의 AAD 에 들어가므로 보내기 전에 알아야 한다). 이미 있거나 상한이면 undefined */
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
   * 고치기. version 이 지금과 다르면(다른 기기가 먼저 고침) 바꾸지 않고 conflict 로 최신 목표를 돌려준다.
   * data·closed 중 준 것만 바꾼다.
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
