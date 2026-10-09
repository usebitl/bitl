/// <reference lib="webworker" />
/**
 * 서비스 워커 (vite.sw.config.ts 가 dist/sw.js 로 따로 빌드).
 *
 * 1. 앱 셸 캐시 — 홈 화면 앱이 네트워크가 느리거나 끊겨도 뜨게.
 *    /assets/* (해시가 붙은 파일) 는 캐시 우선, 페이지는 네트워크 우선. /api 는 절대 캐시하지 않는다.
 * 2. "나를 기다림" 푸시 — 서버는 암호문만 싣는다. 이 기기 IndexedDB 의 키로 풀어서 보여주고,
 *    못 풀면(키 없음) 내용 없이 "작업 1건이 나를 기다리고 있어요".
 */
import { type ApprovalDecision, type ContentKeys, open, openApprovalRequest, signDecision } from '@bitl/shared/client';

declare const self: ServiceWorkerGlobalScope;
declare const __BUILD_ID__: string;

const CACHE = `bitl-${__BUILD_ID__}`;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(['/app', '/manifest.webmanifest', '/icon-192.png']))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n.startsWith('bitl-') && n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) void caches.open(CACHE).then((c) => c.put(url.pathname, res.clone()));
          return res;
        })
        .catch(async () => (await caches.match(url.pathname)) ?? (await caches.match('/app')) ?? Response.error()),
    );
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ??
          fetch(req).then((res) => {
            if (res.ok) void caches.open(CACHE).then((c) => c.put(req, res.clone()));
            return res;
          }),
      ),
    );
  }
});

// ── 푸시 ────────────────────────────────────────────────────────

/** 서버 push.ts 의 PushPayload */
interface PushPayload {
  v: 1;
  key: string;
  status: 'waiting_for_you' | 'error' | string;
  reason?: string;
  attention: number;
  sealed: { title?: string; activity?: string; project?: string; message?: string };
}

/** web/src/keys.ts 와 같은 저장소 (DB bitl, store keys, 레코드 content) */
function readKeys(): Promise<ContentKeys | null> {
  return new Promise((resolve) => {
    const req = indexedDB.open('bitl', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('keys');
    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      const db = req.result;
      try {
        const get = db.transaction('keys', 'readonly').objectStore('keys').get('content');
        get.onsuccess = () => resolve((get.result as ContentKeys | undefined) ?? null);
        get.onerror = () => resolve(null);
      } catch {
        resolve(null);
      } finally {
        db.close();
      }
    };
  });
}

// ── 알림 문구 (한국어·영어) ────────────────────────────────────
// 언어는 페이지에서 고른 값(src/i18n/index.ts 가 캐시 'bitl.prefs' 의 /lang 에 적어 둔다), 없으면 이 기기 언어.

const TEXT = {
  ko: {
    headline: { permission: '권한 승인이 필요해요', question: '질문에 답해주세요', plan: '계획 승인이 필요해요', elicitation: '입력이 필요해요', input: '입력이 필요해요' } as Record<string, string>,
    waiting: '나를 기다리고 있어요',
    error: '오류로 멈췄어요',
    oneWaiting: '작업 1건이 나를 기다리고 있어요',
    settled: { allow: '✓ 허용됨', deny: '✕ 거부됨', cancelled: '터미널에서 답했어요', expired: '시간이 지나 터미널로 넘어갔어요' } as Record<string, string>,
    settledTitle: '승인 요청 끝남',
    settledOther: '끝났어요',
    approval: '승인 요청',
    approvalLocked: '🔒 이 기기의 키로 요청 내용을 열 수 없어요. 눌러서 확인하세요.',
    allow: '허용',
    deny: '거부',
    failNoKey: '이 기기에 키가 없어 답할 수 없어요. 앱을 열어 확인하세요.',
    failNetwork: '보내지 못했어요 (네트워크). 앱을 열어 다시 답하세요.',
    failSettled: '이미 다른 곳에서 답했거나 PC 가 터미널에서 승인하기로 했어요.',
    failGone: '요청이 끝났어요 (시간이 지남).',
  },
  en: {
    headline: { permission: 'Needs your permission', question: 'Has a question for you', plan: 'Needs plan approval', elicitation: 'Needs your input', input: 'Needs your input' } as Record<string, string>,
    waiting: 'Waiting for you',
    error: 'Stopped with an error',
    oneWaiting: '1 task is waiting for you',
    settled: { allow: '✓ Allowed', deny: '✕ Denied', cancelled: 'Answered in the terminal', expired: 'Timed out — moved to the terminal' } as Record<string, string>,
    settledTitle: 'Approval request ended',
    settledOther: 'Ended',
    approval: 'Approval request',
    approvalLocked: '🔒 This device’s key can’t decrypt the request. Tap to check.',
    allow: 'Allow',
    deny: 'Deny',
    failNoKey: 'No key on this device, so it can’t answer. Open the app to check.',
    failNetwork: 'Couldn’t send (network). Open the app and answer again.',
    failSettled: 'Already answered elsewhere, or the PC chose to approve in the terminal.',
    failGone: 'The request has ended (timed out).',
  },
};
type Phrases = (typeof TEXT)['ko'];

async function phrases(): Promise<Phrases> {
  try {
    const res = await (await caches.open('bitl.prefs')).match('/lang');
    const saved = res ? await res.text() : '';
    if (saved === 'ko' || saved === 'en') return TEXT[saved];
  } catch {
    // 캐시를 못 쓰면 기기 언어
  }
  return self.navigator.language.toLowerCase().startsWith('ko') ? TEXT.ko : TEXT.en;
}

/** 서버 push.ts 의 ApprovalPushPayload — 원격 승인 요청 */
interface ApprovalPushPayload {
  v: 1;
  kind: 'approval';
  id: string;
  key: string;
  expiresAt: string;
  /** 봉인된 요청. 크면 빠져 있어 서버에서 받아 온다 */
  request?: string;
}

const approvalTag = (id: string) => `approval:${id}`;

/** 서버 push.ts 의 ApprovalSettledPushPayload — 승인 요청이 끝남 */
interface ApprovalSettledPushPayload {
  v: 1;
  kind: 'approval-settled';
  id: string;
  key: string;
  status: 'allow' | 'deny' | 'cancelled' | 'expired';
}

/**
 * 승인 요청이 끝남: 허용·거부 버튼이 달린 알림을 조용한 알림으로 바꿨다가 몇 초 뒤 닫는다.
 * 웹 푸시는 받으면 알림을 보여야 해서(안 보이면 iOS 는 구독을 끊는다) 바로 지우지 않고 잠깐 바꿔 보여준다.
 */
async function showApprovalSettled(p: ApprovalSettledPushPayload) {
  const tag = approvalTag(p.id);
  const L = await phrases();
  await self.registration.showNotification(L.settledTitle, {
    body: L.settled[p.status] ?? L.settledOther,
    icon: '/icon-192.png',
    badge: '/badge-96.png',
    tag,
    silent: true,
    data: { key: p.key },
  });
  await new Promise((r) => setTimeout(r, 4000));
  for (const n of await self.registration.getNotifications({ tag })) n.close();
}

/** 원격 승인 요청: 무엇을 하려는지 + 허용·거부 버튼 (버튼은 Android 등 지원하는 곳만, 아니면 눌러서 앱에서) */
async function showApproval(p: ApprovalPushPayload) {
  const keys = await readKeys();
  let sealed = p.request;
  if (!sealed) {
    const res = await fetch(`/api/approvals/${encodeURIComponent(p.id)}`).catch(() => null);
    sealed = res?.ok ? ((await res.json()) as { request?: string }).request : undefined;
  }
  const req = keys && sealed ? await openApprovalRequest(keys, p.id, sealed).catch(() => undefined) : undefined;
  // 같은 카드의 "나를 기다림" 알림은 이 알림으로 바꾼다 (버튼이 있는 쪽을 남긴다)
  for (const n of await self.registration.getNotifications({ tag: p.key })) n.close();
  const L = await phrases();
  await self.registration.showNotification(req?.project ? `${req.project} · ${L.approval}` : L.approval, {
    body: req ? [req.summary, req.description].filter(Boolean).join('\n') : L.approvalLocked,
    icon: '/icon-192.png',
    badge: '/badge-96.png',
    tag: approvalTag(p.id),
    data: { key: p.key, approvalId: p.id, readable: Boolean(req) },
    requireInteraction: true,
    // 내용을 풀 수 있을 때만 바로 허용 버튼 (무엇인지 모르는 요청을 허용하지 않게)
    ...({ actions: req ? [{ action: 'allow', title: L.allow }, { action: 'deny', title: L.deny }] : [{ action: 'deny', title: L.deny }] } as object),
  });
}

/** 알림의 버튼으로 결정: 이 기기의 키로 서명해 보낸다 */
async function decideFromNotification(id: string, decision: ApprovalDecision, key?: string) {
  const [keys, L] = await Promise.all([readKeys(), phrases()]);
  const fail = (body: string) =>
    self.registration.showNotification(L.approval, { body, icon: '/icon-192.png', badge: '/badge-96.png', tag: approvalTag(id), data: { key } });
  if (!keys) return fail(L.failNoKey);
  const res = await fetch(`/api/approvals/${encodeURIComponent(id)}/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision, sig: await signDecision(keys, id, decision) }),
  }).catch(() => null);
  if (!res) return fail(L.failNetwork);
  if (res.status === 409) return fail(L.failSettled);
  if (!res.ok) return fail(L.failGone);
}

async function show(payload: PushPayload | ApprovalPushPayload | ApprovalSettledPushPayload | null) {
  if (payload && 'kind' in payload && payload.kind === 'approval') return showApproval(payload);
  if (payload && 'kind' in payload && payload.kind === 'approval-settled') return showApprovalSettled(payload);
  const p = payload as PushPayload | null;
  const L = await phrases();
  if (p && (await self.registration.getNotifications()).some((n) => (n.data as { key?: string; approvalId?: string } | null)?.approvalId && n.data.key === p.key))
    return; // 이 카드에 승인 요청 알림이 떠 있으면 그것을 남긴다
  if (!p || p.v !== 1) {
    await self.registration.showNotification('BITL', { body: L.oneWaiting, icon: '/icon-192.png', tag: 'bitl' });
    return;
  }
  const keys = await readKeys();
  const text = async (s?: string) => (keys && s ? open(keys, s, p.key).catch(() => undefined) : undefined);
  const [title, activity, project, message] = await Promise.all([
    text(p.sealed.title),
    text(p.sealed.activity),
    text(p.sealed.project),
    text(p.sealed.message),
  ]);
  const headline = p.status === 'error' ? L.error : (L.headline[p.reason ?? ''] ?? L.waiting);
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const body = [activity ?? message, title && title !== activity ? title : undefined].filter(Boolean).map((s) => clip(s!, 140));
  await self.registration.showNotification(project ? `${project} · ${headline}` : headline, {
    body: body.length ? body.join('\n') : L.oneWaiting,
    icon: '/icon-192.png',
    badge: '/badge-96.png',
    // 같은 카드의 알림은 하나로 (새 알림이 이전 것을 바꾼다)
    tag: p.key,
    data: { key: p.key },
    // TS 의 DOM 타입에 아직 없는 옵션 — 같은 tag 라도 다시 울리게
    ...({ renotify: true } as object),
  });
  // 홈 화면 아이콘 숫자 (지원하는 곳만)
  await (self.navigator as WorkerNavigator & { setAppBadge?: (n: number) => Promise<void> }).setAppBadge?.(p.attention).catch(() => {});
}

self.addEventListener('push', (e) => {
  let payload: PushPayload | ApprovalPushPayload | ApprovalSettledPushPayload | null = null;
  try {
    payload = (e.data?.json() as PushPayload | ApprovalPushPayload | ApprovalSettledPushPayload | undefined) ?? null;
  } catch {}
  e.waitUntil(show(payload));
});

// 알림을 누르면 그 카드를 연다 (이미 열린 BITL 창이 있으면 그 창에서)
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const data = e.notification.data as { key?: string; approvalId?: string } | null;
  const key = data?.key;
  if (data?.approvalId && (e.action === 'allow' || e.action === 'deny')) {
    e.waitUntil(decideFromNotification(data.approvalId, e.action, key));
    return;
  }
  const target = key ? `/app#s=${encodeURIComponent(key)}` : '/app';
  e.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
      if (win) {
        await win.focus();
        // 열린 앱이 메시지를 받아 그 카드의 상세를 연다 (pwa.ts)
        win.postMessage({ type: 'open-session', key });
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});
