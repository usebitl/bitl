import type { Driver, Row } from './types.js';

/**
 * Remote approval. Relays approval requests posted by the PC's hook until the phone allows or denies them.
 * The server doesn't know the content (sealed request) and can't produce a decision signature — the phone signs and the PC verifies (shared/approval.ts).
 *
 * Remote approval mode (the away column — originally named 'away mode'): the PC's hook waits for the phone's answer only for accounts that turned it on.
 * When off, the hook backs off immediately and nothing goes to the phone. When on, the terminal prompt still appears and whichever side answers first applies.
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

/** pending → allow | deny (phone's decision) | cancelled (PC stopped waiting) | expired */
export type ApprovalStatus = 'pending' | 'allow' | 'deny' | 'cancelled' | 'expired';

export interface Approval {
  id: string;
  sessionKey: string;
  /** Sealed request (AAD = approval id) */
  request: string;
  status: ApprovalStatus;
  /** Phone's signature (for allow/deny) */
  sig?: string;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
}

export type ApprovalChange = { accountId: string; approval: Approval };

/** Max time a single request can wait */
export const MAX_APPROVAL_TTL_MS = 60 * 60_000;
/** How long decided/expired requests are kept */
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
        // So one subscriber's error doesn't block the others
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

  /** New request. false if the id already exists (practically never, since the PC generates it randomly) */
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

  /** Requests still awaiting an answer (not yet expired) */
  async listPending(accountId: string, now = new Date()): Promise<Approval[]> {
    const { rows } = await this.db.query(
      `SELECT ${COLUMNS} FROM approvals WHERE account_id = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at`,
      [accountId, now.toISOString()],
    );
    return rows.map(toApproval);
  }

  /**
   * Only changes pending requests (first decision wins). Returns the updated request, or undefined.
   * Decisions (allow/deny) are accepted only before expiry.
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
   * Closes all pending requests for this card (cancelled). Returns the count.
   * If answered in the terminal first, Claude Code carries on and the card leaves "waiting for you" — then the phone/board requests are cleared
   */
  async cancelForSession(accountId: string, sessionKey: string, now = new Date()): Promise<number> {
    const { rows } = await this.db.query(`SELECT id FROM approvals WHERE account_id = ? AND session_key = ? AND status = 'pending'`, [accountId, sessionKey]);
    let n = 0;
    for (const r of rows) if (await this.settle(accountId, r.id as string, 'cancelled', undefined, now)) n++;
    return n;
  }

  /** Marks timed-out requests expired and deletes old records (all accounts). Returns the number expired */
  async sweep(now = new Date()): Promise<number> {
    const t = now.toISOString();
    const { rows } = await this.db.query(`SELECT account_id, ${COLUMNS} FROM approvals WHERE status = 'pending' AND expires_at <= ?`, [t]);
    for (const r of rows) await this.settle(r.account_id as string, r.id as string, 'expired', undefined, now);
    await this.db.transaction((q) => q('DELETE FROM approvals WHERE created_at < ?', [new Date(now.getTime() - KEEP_MS).toISOString()]));
    return rows.length;
  }
}
