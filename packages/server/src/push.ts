import { createHash } from 'node:crypto';
import type { StoredSession } from '@bitl/shared';
import webpush from 'web-push';
import type { Approval, ApprovalStore, PushStore, PushSubscriptionRow, SessionStore } from './store/index.js';

/**
 * "나를 기다림" 알림.
 * 카드가 나를 기다림(권한 승인·질문 대기) 또는 오류로 **바뀌는 순간** 그 계정의 구독한 기기로 푸시를 보낸다.
 *
 * 서버는 카드 내용을 모른다: 이미 가진 암호문(제목·현재 활동·프로젝트)을 그대로 싣고,
 * 휴대폰의 서비스 워커가 그 기기의 키로 풀어서 보여준다. 못 풀면 "작업 1건이 나를 기다리고 있어요".
 * 알림 자체도 구독 키로 암호화되어(RFC 8291) push 서비스는 내용을 보지 못한다.
 */

export interface PushPayload {
  v: 1;
  key: string;
  status: StoredSession['status'];
  reason?: string;
  source: StoredSession['source'];
  /** 나를 기다리는 작업 수 (이 알림 포함) */
  attention: number;
  /** 세션 키가 AAD 인 암호문 — 서비스 워커가 푼다 */
  sealed: { title?: string; activity?: string; project?: string; message?: string };
}

/** 원격 승인 요청 알림 — 폰이 허용·거부 버튼을 보여준다. 요청 내용(봉인)이 크면 빼고, 서비스 워커가 따로 받아 온다 */
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
 * 승인 요청이 끝났음 — 폰이 허용·거부 버튼이 달린 알림을 조용한 알림으로 바꿨다가 닫는다.
 * (웹 푸시는 받으면 알림을 보여야 한다: 아무것도 안 보이면 iOS 는 구독을 끊고 크롬은 기본 알림을 띄운다)
 * 같은 topic 으로 보내 아직 전달되지 않은 승인 요청 알림도 이것으로 바뀐다.
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

/** 실제 발송 (VAPID) */
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
/** push 서비스의 본문 한도(약 4KB)를 넘지 않게 */
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
 * 저장소 변화를 듣고 알림을 보낸다. 돌려주는 함수를 부르면 멈춘다.
 * cooldownMs: 같은 카드에 대한 알림 최소 간격 (대기 → 진행 → 대기가 빠르게 반복돼도 한 번만)
 */
export function startPushNotifier(opts: {
  store: SessionStore;
  push: PushStore;
  sender: PushSender;
  /** 있으면 원격 승인 요청도 알린다 */
  approvals?: ApprovalStore;
  /** 이 계정에 알려도 되는가 (요금제: 읽기 전용이면 알리지 않는다) */
  canNotify?: (accountId: string) => Promise<boolean>;
  cooldownMs?: number;
  onError?: (err: unknown) => void;
}): { stop: () => void; idle: () => Promise<void> } {
  const { store, push, sender, cooldownMs = 60_000 } = opts;
  const lastSent = new Map<string, number>();
  let inflight = Promise.resolve();

  // 같은 대상의 전달 안 된 알림은 새 것으로 바꾼다 (topic: URL-safe 32자 이내)
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
    const attention = (await store.listSessions(accountId)).filter((x) => ALERT.has(x.status)).length;
    await sendAll(accountId, buildPayload(s, attention), topicOf(s.key));
  };

  const off = store.subscribe((change) => {
    if (change.type !== 'session') return;
    const s = change.session;
    if (!ALERT.has(s.status) || change.prevStatus === s.status) return;
    const id = `${change.accountId}\n${s.key}`;
    const t = Date.now();
    if (t - (lastSent.get(id) ?? 0) < cooldownMs) return;
    lastSent.set(id, t);
    if (lastSent.size > 10_000) lastSent.clear();
    inflight = inflight.then(() => notify(change.accountId, s)).catch((err) => opts.onError?.(err));
  });
  // 원격 승인: 새 요청마다 바로 (쿨다운 없음 — 요청마다 답이 필요하다)
  // 끝나면(허용·거부·터미널에서 답함·시간 초과) 같은 topic 으로 정리 알림 — 폰에 남은 버튼 달린 알림을 치운다
  const offApprovals = opts.approvals?.subscribe(({ accountId, approval }) => {
    const payload = approval.status === 'pending' ? buildApprovalPayload(approval) : buildApprovalSettledPayload(approval);
    inflight = inflight.then(() => sendAll(accountId, payload, topicOf(`approval:${approval.id}`))).catch((err) => opts.onError?.(err));
  });
  return {
    stop: () => {
      off();
      offApprovals?.();
    },
    idle: () => inflight,
  };
}
