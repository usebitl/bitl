import { createHash } from 'node:crypto';
import { isEmptySession, type StoredSession } from '@bitl/shared';
import webpush from 'web-push';
import type { Approval, ApprovalStore, PushStore, PushSubscriptionRow, SessionStore } from './store/index.js';

/**
 * "Waiting for you" notifications.
 * The **moment** a card turns waiting for you (question pending) or error, push to the account's subscribed devices.
 * A permission wait is pushed only if it is still pending a few seconds later (PERMISSION_PUSH_DELAY_MS).
 *
 * The server doesn't know card contents: it ships the ciphertext it already has (title, current activity, project) as is,
 * and the phone's service worker decrypts it with the device key. If it can't, it shows "1 task is waiting for you".
 * The notification itself is encrypted with the subscription key (RFC 8291), so the push service can't read it.
 */

export interface PushPayload {
  v: 1;
  key: string;
  status: StoredSession['status'];
  reason?: string;
  source: StoredSession['source'];
  /** Number of tasks waiting for you (including this one) */
  attention: number;
  /** Ciphertexts with the session key as AAD — the service worker decrypts them */
  sealed: { title?: string; activity?: string; project?: string; message?: string };
}

/** Remote approval request notification — the phone shows allow/deny buttons. A large sealed request is left out and the service worker fetches it separately */
export interface ApprovalPushPayload {
  v: 1;
  kind: 'approval';
  id: string;
  key: string;
  expiresAt: string;
  request?: string;
}

export function buildApprovalPayload(a: Approval): string {
  const payload: ApprovalPushPayload = { v: 1, kind: 'approval', id: a.id, key: a.sessionKey, expiresAt: a.expiresAt, request: a.request };
  const json = JSON.stringify(payload);
  return json.length <= MAX_PAYLOAD ? json : JSON.stringify({ ...payload, request: undefined });
}

/**
 * Approval request finished — the phone replaces the allow/deny notification with a silent one, then closes it.
 * (A received web push must show a notification: if nothing shows, iOS drops the subscription and Chrome shows a default one)
 * It uses the same topic, so an undelivered approval request notification is replaced by this too.
 */
export interface ApprovalSettledPushPayload {
  v: 1;
  kind: 'approval-settled';
  id: string;
  key: string;
  status: 'allow' | 'deny' | 'cancelled' | 'expired';
}

export const buildApprovalSettledPayload = (a: Approval): string =>
  JSON.stringify({ v: 1, kind: 'approval-settled', id: a.id, key: a.sessionKey, status: a.status as ApprovalSettledPushPayload['status'] } satisfies ApprovalSettledPushPayload);

export type SendResult = 'ok' | 'gone' | 'failed';
export type PushSender = (sub: PushSubscriptionRow, payload: string, topic: string) => Promise<SendResult>;

/** Actual delivery (VAPID) */
export function webPushSender(vapid: { publicKey: string; privateKey: string; subject: string }): PushSender {
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  return async (sub, payload, topic) => {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload, { TTL: 12 * 3600, urgency: 'high', topic });
      return 'ok';
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode;
      return code === 404 || code === 410 ? 'gone' : 'failed';
    }
  };
}

const ALERT: ReadonlySet<StoredSession['status']> = new Set(['waiting_for_you', 'error']);
/** Stay under the push service's payload limit (~4 KB) */
const MAX_PAYLOAD = 3500;
const MAX_FIELD = 1500;

export function buildPayload(s: StoredSession, attention: number): string {
  const pick = (v?: string) => (v && v.length <= MAX_FIELD ? v : undefined);
  const payload: PushPayload = {
    v: 1,
    key: s.key,
    status: s.status,
    reason: s.waitingReason,
    source: s.source,
    attention,
    sealed: {
      title: pick(s.enc.aiTitle ?? s.enc.title),
      activity: pick(s.enc.currentActivity),
      project: pick(s.enc.project),
      message: s.status === 'error' ? pick(s.enc.lastMessage) : undefined,
    },
  };
  let json = JSON.stringify(payload);
  if (json.length > MAX_PAYLOAD) json = JSON.stringify({ ...payload, sealed: { title: payload.sealed.title } });
  if (json.length > MAX_PAYLOAD) json = JSON.stringify({ ...payload, sealed: {} });
  return json;
}

/**
 * A permission request that is still pending after this long is a real wait. Claude Code fires PermissionRequest even when
 * nobody gets asked — a subagent's request that is resolved without a prompt (its tool runs and ends within a few seconds) —
 * while a prompt that is really shown is followed by Claude Code's Notification(permission_prompt) about 6 s later.
 * Measured on 2026-11-04: 12 of 40 permission requests flipped back to running within 10 s, the tool ending within 5 s.
 */
export const PERMISSION_PUSH_DELAY_MS = 8_000;

/**
 * Listens to store changes and sends notifications. Call the returned function to stop.
 * cooldownMs: minimum interval between notifications for the same card (just once even if waiting → running → waiting flips quickly)
 * permissionDelayMs: a permission wait is notified only if the card is still waiting after this long (0 = at once)
 */
export function startPushNotifier(opts: {
  store: SessionStore;
  push: PushStore;
  sender: PushSender;
  /** If set, remote approval requests are notified too */
  approvals?: ApprovalStore;
  /** Whether this account may be notified (billing: not when read-only) */
  canNotify?: (accountId: string) => Promise<boolean>;
  cooldownMs?: number;
  permissionDelayMs?: number;
  onError?: (err: unknown) => void;
}): { stop: () => void; idle: () => Promise<void> } {
  const { store, push, sender, cooldownMs = 60_000, permissionDelayMs = PERMISSION_PUSH_DELAY_MS } = opts;
  const lastSent = new Map<string, number>();
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  let inflight = Promise.resolve();

  // Replace undelivered notifications for the same target with the new one (topic: URL-safe, up to 32 chars)
  const topicOf = (v: string) => createHash('sha256').update(v).digest('base64url').slice(0, 32);

  const sendAll = async (accountId: string, payload: string, topic: string) => {
    if (opts.canNotify && !(await opts.canNotify(accountId))) return;
    const subs = await push.list(accountId);
    await Promise.all(
      subs.map(async (sub) => {
        const r = await sender(sub, payload, topic);
        if (r === 'ok') await push.markOk(sub.id);
        else await push.markFailed(sub.id, r === 'gone');
      }),
    );
  };

  const notify = async (accountId: string, s: StoredSession) => {
    if (!(await push.list(accountId)).length) return;
    const attention = (await store.listSessions(accountId)).filter((x) => ALERT.has(x.status) && !isEmptySession(x) && !x.cleared && !x.replacedBy).length;
    await sendAll(accountId, buildPayload(s, attention), topicOf(s.key));
  };

  // Empty sessions are not on the board (e.g. one relaying other sessions' notifications) — those sessions notify for themselves
  // Cleared cards are off the board too (a card that needs the user again is no longer cleared)
  const alerting = (s: StoredSession) => ALERT.has(s.status) && !isEmptySession(s) && !s.cleared && !s.replacedBy;

  /** Cooldown per card: true if this card may be notified now (and records it) */
  const claim = (accountId: string, s: StoredSession) => {
    const id = `${accountId}\n${s.key}`;
    const t = Date.now();
    if (t - (lastSent.get(id) ?? 0) < cooldownMs) return false;
    lastSent.set(id, t);
    if (lastSent.size > 10_000) lastSent.clear();
    return true;
  };
  const send = (accountId: string, s: StoredSession) => {
    if (claim(accountId, s)) inflight = inflight.then(() => notify(accountId, s)).catch((err) => opts.onError?.(err));
  };

  const off = store.subscribe((change) => {
    if (change.type !== 'session') return;
    const s = change.session;
    const id = `${change.accountId}\n${s.key}`;
    if (change.prevStatus === s.status) return;
    // The card moved on: a permission wait that hasn't been notified yet is dropped
    clearTimeout(pending.get(id));
    pending.delete(id);
    if (!alerting(s)) return;
    if (s.status !== 'waiting_for_you' || s.waitingReason !== 'permission' || permissionDelayMs <= 0) return send(change.accountId, s);
    // A permission wait: notify only if the card is still waiting after the delay (with what it shows by then)
    pending.set(
      id,
      setTimeout(() => {
        pending.delete(id);
        inflight = inflight
          .then(async () => {
            const now = await store.getSession(change.accountId, s.key);
            if (now && now.status === 'waiting_for_you' && alerting(now) && claim(change.accountId, now)) await notify(change.accountId, now);
          })
          .catch((err) => opts.onError?.(err));
      }, permissionDelayMs),
    );
  });
  // Remote approval: immediately for each new request (no cooldown — every request needs an answer)
  // When it ends (allow, deny, answered in the terminal, timeout), send a cleanup notification with the same topic — clears the leftover button notification on the phone
  const offApprovals = opts.approvals?.subscribe(({ accountId, approval }) => {
    const payload = approval.status === 'pending' ? buildApprovalPayload(approval) : buildApprovalSettledPayload(approval);
    inflight = inflight.then(() => sendAll(accountId, payload, topicOf(`approval:${approval.id}`))).catch((err) => opts.onError?.(err));
  });
  return {
    stop: () => {
      off();
      offApprovals?.();
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    },
    idle: () => inflight,
  };
}
