import { randomBytes } from 'node:crypto';
import type { Driver, Row } from './types.js';

/**
 * 웹 푸시 구독 (PWA 알림). 브라우저가 준 push 서비스 주소와 암호화 키를 계정별로 보관한다.
 * 내용은 알림을 보낼 때 이 키로 암호화된다 (RFC 8291) — push 서비스(Google·Apple 등)는 알림 내용을 모른다.
 */
export const PUSH_SCHEMA = `
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  last_ok_at  TEXT,
  failures    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS push_subscriptions_account ON push_subscriptions(account_id);
`;

export interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

const now = () => new Date().toISOString();
/** 계속 실패하는 구독은 지운다 (브라우저가 구독을 버렸거나 기기가 사라짐) */
const MAX_FAILURES = 5;

export class PushStore {
  constructor(private readonly db: Driver) {}

  /** 같은 브라우저(endpoint)가 다시 구독하면 그 계정 것으로 덮어쓴다 */
  async subscribe(accountId: string, sub: { endpoint: string; p256dh: string; auth: string }): Promise<void> {
    await this.db.transaction(async (q) => {
      await q('DELETE FROM push_subscriptions WHERE endpoint = ?', [sub.endpoint]);
      await q('INSERT INTO push_subscriptions (id, account_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
        randomBytes(12).toString('base64url'),
        accountId,
        sub.endpoint,
        sub.p256dh,
        sub.auth,
        now(),
      ]);
    });
  }

  async unsubscribe(accountId: string, endpoint: string): Promise<boolean> {
    return this.db.transaction(
      async (q) => (await q('DELETE FROM push_subscriptions WHERE account_id = ? AND endpoint = ?', [accountId, endpoint])).changes > 0,
    );
  }

  async list(accountId: string): Promise<PushSubscriptionRow[]> {
    const { rows } = await this.db.query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE account_id = ?', [accountId]);
    return rows.map((r: Row) => ({ id: r.id as string, endpoint: r.endpoint as string, keys: { p256dh: r.p256dh as string, auth: r.auth as string } }));
  }

  async has(accountId: string, endpoint: string): Promise<boolean> {
    const { rows } = await this.db.query('SELECT 1 FROM push_subscriptions WHERE account_id = ? AND endpoint = ?', [accountId, endpoint]);
    return rows.length > 0;
  }

  async markOk(id: string) {
    await this.db.transaction((q) => q('UPDATE push_subscriptions SET last_ok_at = ?, failures = 0 WHERE id = ?', [now(), id]));
  }

  /** 실패를 센다. gone(404·410: 구독이 없어짐)이면 바로, 아니면 여러 번 실패하면 지운다 */
  async markFailed(id: string, gone: boolean) {
    await this.db.transaction(async (q) => {
      if (gone) await q('DELETE FROM push_subscriptions WHERE id = ?', [id]);
      else {
        await q('UPDATE push_subscriptions SET failures = failures + 1 WHERE id = ?', [id]);
        await q('DELETE FROM push_subscriptions WHERE id = ? AND failures >= ?', [id, MAX_FAILURES]);
      }
    });
  }
}
