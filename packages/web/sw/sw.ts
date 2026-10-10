/// <reference lib="webworker" />
/**
 * Service worker (built separately to dist/sw.js by vite.sw.config.ts).
 *
 * 1. App shell cache — so the home screen app opens even on a slow or offline network.
 *    /assets/* (hashed files) are cache-first, pages network-first. /api is never cached.
 * 2. "Waiting for you" push — the server sends only ciphertext. It is decrypted with the key in this device's IndexedDB;
 *    if that fails (no key), a contentless "1 task is waiting for you".
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

// ── Push ───────────────────────────────────────────────────────────

/** PushPayload from the server's push.ts */
interface PushPayload {
  v: 1;
  key: string;
  status: 'waiting_for_you' | 'error' | string;
  reason?: string;
  attention: number;
  sealed: { title?: string; activity?: string; project?: string; message?: string };
}

/** Same storage as web/src/keys.ts (DB bitl, store keys, record content) */
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

// ── Notification strings (Korean / English) ────────────────────────
// Language is the one chosen in the page (src/i18n/index.ts writes it to /lang in the 'bitl.prefs' cache), otherwise the device language.

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
    // device language if the cache is unavailable
  }
  return self.navigator.language.toLowerCase().startsWith('ko') ? TEXT.ko : TEXT.en;
}

/** ApprovalPushPayload from the server's push.ts — a remote approval request */
interface ApprovalPushPayload {
  v: 1;
  kind: 'approval';
  id: string;
  key: string;
  expiresAt: string;
  /** Sealed request. Omitted when large, then fetched from the server */
  request?: string;
}

const approvalTag = (id: string) => `approval:${id}`;

/** ApprovalSettledPushPayload from the server's push.ts — an approval request was settled */
interface ApprovalSettledPushPayload {
  v: 1;
  kind: 'approval-settled';
  id: string;
  key: string;
  status: 'allow' | 'deny' | 'cancelled' | 'expired';
}

/**
 * Approval request settled: replace the notification with allow/deny buttons by a silent one, then close it after a few seconds.
 * A web push must show a notification (iOS drops the subscription otherwise), so instead of removing it right away we briefly show the replacement.
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

/** Remote approval request: what it wants to do + allow/deny buttons (buttons only where supported, e.g. Android; otherwise tap to answer in the app) */
async function showApproval(p: ApprovalPushPayload) {
  const keys = await readKeys();
  let sealed = p.request;
  if (!sealed) {
    const res = await fetch(`/api/approvals/${encodeURIComponent(p.id)}`).catch(() => null);
    sealed = res?.ok ? ((await res.json()) as { request?: string }).request : undefined;
  }
  const req = keys && sealed ? await openApprovalRequest(keys, p.id, sealed).catch(() => undefined) : undefined;
  // this replaces the same card's "waiting for you" notification (keep the one with buttons)
  for (const n of await self.registration.getNotifications({ tag: p.key })) n.close();
  const L = await phrases();
  await self.registration.showNotification(req?.project ? `${req.project} · ${L.approval}` : L.approval, {
    body: req ? [req.summary, req.description].filter(Boolean).join('\n') : L.approvalLocked,
    icon: '/icon-192.png',
    badge: '/badge-96.png',
    tag: approvalTag(p.id),
    data: { key: p.key, approvalId: p.id, readable: Boolean(req) },
    requireInteraction: true,
    // offer the allow button only when the content can be decrypted (never allow an unknown request)
    ...({ actions: req ? [{ action: 'allow', title: L.allow }, { action: 'deny', title: L.deny }] : [{ action: 'deny', title: L.deny }] } as object),
  });
}

/** Decision from a notification button: signed with this device's key and sent */
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
    return; // if this card has an approval request notification showing, keep it
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
    // one notification per card (a new one replaces the previous)
    tag: p.key,
    data: { key: p.key },
    // option not yet in TS DOM types — alert again even with the same tag
    ...({ renotify: true } as object),
  });
  // home screen icon number (where supported)
  await (self.navigator as WorkerNavigator & { setAppBadge?: (n: number) => Promise<void> }).setAppBadge?.(p.attention).catch(() => {});
}

self.addEventListener('push', (e) => {
  let payload: PushPayload | ApprovalPushPayload | ApprovalSettledPushPayload | null = null;
  try {
    payload = (e.data?.json() as PushPayload | ApprovalPushPayload | ApprovalSettledPushPayload | undefined) ?? null;
  } catch {}
  e.waitUntil(show(payload));
});

// Clicking a notification opens that card (in an already-open BITL window if there is one)
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
        // the open app receives the message and opens that card's detail (pwa.ts)
        win.postMessage({ type: 'open-session', key });
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});
