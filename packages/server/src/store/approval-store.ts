import type { Driver, Row } from './types.js';

/**
 * 원격 승인. PC 의 hook 이 올린 승인 요청을 폰이 허용·거부할 때까지 중계한다.
 * 서버는 내용(봉인된 요청)을 모르고, 결정의 서명을 만들 수도 없다 — 폰이 서명하고 PC 가 확인한다 (shared/approval.ts).
 *
 * 원격 승인 모드(away 열 — 처음 이름 '자리 비움'): 켠 계정만 PC 의 hook 이 폰의 답을 기다린다.
 * 끄면 hook 은 바로 물러나 폰에 요청이 가지 않는다. 켜도 터미널 승인 창은 뜨고, 먼저 답한 쪽이 적용된다.
 */
export const APPROVAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS approvals (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL,
  session_key TEXT NOT NULL,
  device_id   TEXT,
  request     TEXT NOT NULL,
  status      TEXT NOT NULL,
  sig         TEXT,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  decided_at  TEXT
);
CREATE INDEX IF NOT EXISTS approvals_account ON approvals(account_id, status);

CREATE TABLE IF NOT EXISTS account_prefs (
  account_id TEXT PRIMARY KEY,
  away       INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
`;

/** pending → allow | deny (폰의 결정) | cancelled (PC 가 그만 기다림) | expired */
export type ApprovalStatus = 'pending' | 'allow' | 'deny' | 'cancelled' | 'expired';

export interface Approval {
  id: string;
  sessionKey: string;
  /** 봉인된 요청 (AAD = 승인 id) */
  request: string;
  status: ApprovalStatus;
  /** 폰의 서명 (allow·deny 일 때) */
  sig?: string;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
}

export type ApprovalChange = { accountId: string; approval: Approval };

/** 요청 하나가 기다릴 수 있는 최대 시간 */
export const MAX_APPROVAL_TTL_MS = 60 * 60_000;
/** 결정된·만료된 요청을 남겨 두는 기간 */
const KEEP_MS = 7 * 86_400_000;

const toApproval = (r: Row): Approval => ({
  id: r.id as string,
  sessionKey: r.session_key as string,
  request: r.request as string,
  status: r.status as ApprovalStatus,
  sig: (r.sig as string | null) ?? undefined,
  createdAt: r.created_at as string,
  expiresAt: r.expires_at as string,
  decidedAt: (r.decided_at as string | null) ?? undefined,
});

const COLUMNS = 'id, session_key, request, status, sig, created_at, expires_at, decided_at';

export class ApprovalStore {
  private readonly listeners = new Set<(c: ApprovalChange) => void>();

  constructor(private readonly db: Driver) {}

  subscribe(fn: (c: ApprovalChange) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(accountId: string, approval: Approval | undefined) {
    if (!approval) return;
    for (const fn of this.listeners) {
      try {
        fn({ accountId, approval });
      } catch {
        // 구독자 하나의 오류가 다른 구독자를 막지 않게
      }
    }
  }

  async isAway(accountId: string): Promise<boolean> {
    const { rows } = await this.db.query('SELECT away FROM account_prefs WHERE account_id = ?', [accountId]);
    return Number(rows[0]?.away ?? 0) === 1;
  }

  async setAway(accountId: string, away: boolean): Promise<void> {
    await this.db.transaction(async (q) => {
      const v = away ? 1 : 0;
      const t = new Date().toISOString();
      const { changes } = await q('UPDATE account_prefs SET away = ?, updated_at = ? WHERE account_id = ?', [v, t, accountId]);
      if (!changes) await q('INSERT INTO account_prefs (account_id, away, updated_at) VALUES (?, ?, ?)', [accountId, v, t]);
    });
  }

  /** 새 요청. 같은 id 가 이미 있으면 false (PC 가 무작위로 만들므로 사실상 일어나지 않는다) */
  async create(
    accountId: string,
    a: { id: string; sessionKey: string; request: string; deviceId?: string; ttlMs: number },
    now = new Date(),
  ): Promise<Approval | undefined> {
    const ttl = Math.min(Math.max(a.ttlMs, 10_000), MAX_APPROVAL_TTL_MS);
    const created = await this.db.transaction(async (q) => {
      const { rows } = await q('SELECT 1 FROM approvals WHERE id = ?', [a.id]);
      if (rows.length) return false;
      await q(
        'INSERT INTO approvals (id, account_id, session_key, device_id, request, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [a.id, accountId, a.sessionKey, a.deviceId ?? null, a.request, 'pending', now.toISOString(), new Date(now.getTime() + ttl).toISOString()],
      );
      return true;
    });
    if (!created) return undefined;
    const approval = await this.get(accountId, a.id);
    this.emit(accountId, approval);
    return approval;
  }

  async get(accountId: string, id: string): Promise<Approval | undefined> {
    const { rows } = await this.db.query(`SELECT ${COLUMNS} FROM approvals WHERE account_id = ? AND id = ?`, [accountId, id]);
    return rows[0] ? toApproval(rows[0]) : undefined;
  }

  /** 아직 답을 기다리는 요청 (만료 전) */
  async listPending(accountId: string, now = new Date()): Promise<Approval[]> {
    const { rows } = await this.db.query(
      `SELECT ${COLUMNS} FROM approvals WHERE account_id = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at`,
      [accountId, now.toISOString()],
    );
    return rows.map(toApproval);
  }

  /**
   * pending 인 요청만 바꾼다 (먼저 온 결정이 이긴다). 바꿨으면 바뀐 요청, 아니면 undefined.
   * 결정(allow·deny)은 만료 전에만 받는다.
   */
  async settle(accountId: string, id: string, to: Exclude<ApprovalStatus, 'pending'>, sig?: string, now = new Date()): Promise<Approval | undefined> {
    const decided = to === 'allow' || to === 'deny';
    const { changes } = await this.db.transaction((q) =>
      q(
        `UPDATE approvals SET status = ?, sig = ?, decided_at = ? WHERE account_id = ? AND id = ? AND status = 'pending'${decided ? ' AND expires_at > ?' : ''}`,
        [to, sig ?? null, now.toISOString(), accountId, id, ...(decided ? [now.toISOString()] : [])],
      ),
    );
    if (!changes) return undefined;
    const approval = await this.get(accountId, id);
    this.emit(accountId, approval);
    return approval;
  }

  /**
   * 이 카드의 기다리는 요청을 모두 닫는다 (cancelled). 바뀐 수.
   * 터미널에서 먼저 답하면 Claude Code 가 이어서 진행해 카드가 "나를 기다림"을 벗어난다 — 그때 폰·보드의 요청을 치운다
   */
  async cancelForSession(accountId: string, sessionKey: string, now = new Date()): Promise<number> {
    const { rows } = await this.db.query(`SELECT id FROM approvals WHERE account_id = ? AND session_key = ? AND status = 'pending'`, [accountId, sessionKey]);
    let n = 0;
    for (const r of rows) if (await this.settle(accountId, r.id as string, 'cancelled', undefined, now)) n++;
    return n;
  }

  /** 만료된 요청을 expired 로, 오래된 기록은 지운다 (모든 계정). 만료로 바꾼 수 */
  async sweep(now = new Date()): Promise<number> {
    const t = now.toISOString();
    const { rows } = await this.db.query(`SELECT account_id, ${COLUMNS} FROM approvals WHERE status = 'pending' AND expires_at <= ?`, [t]);
    for (const r of rows) await this.settle(r.account_id as string, r.id as string, 'expired', undefined, now);
    await this.db.transaction((q) => q('DELETE FROM approvals WHERE created_at < ?', [new Date(now.getTime() - KEEP_MS).toISOString()]));
    return rows.length;
  }
}
