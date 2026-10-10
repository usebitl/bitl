import { randomBytes } from 'node:crypto';
import type { Driver, Row } from './types.js';

/**
 * Web push subscriptions (PWA notifications). Stores the push service endpoint and encryption keys from the browser, per account.
 * Payloads are encrypted with these keys when sent (RFC 8291) — the push service (Google, Apple, etc.) can't read them.
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
/** Subscriptions that keep failing are deleted (the browser dropped it or the device is gone) */
const MAX_FAILURES = 5;

export class PushStore {
  constructor(private readonly db: Driver) {}

  /** If the same browser (endpoint) subscribes again, it's reassigned to that account */
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

  /** Counts a failure. Deletes right away if gone (404/410: subscription no longer exists), otherwise after repeated failures */
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
