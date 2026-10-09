import { useEffect, useState, useSyncExternalStore } from 'react';
import { t } from './i18n';

/**
 * 홈 화면 앱(PWA)과 "나를 기다림" 알림.
 * 서비스 워커는 sw/sw.ts (빌드하면 /sw.js). 개발 서버(vite dev)에서는 등록하지 않는다.
 */

export function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('서비스 워커 등록 실패:', err));
  });
}

/** 알림을 누르면 열린 앱에 카드 키를 보낸다 → 그 카드의 상세를 연다 */
export function useOpenFromNotification(open: (key: string) => void) {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; key?: string } | null;
      if (d?.type === 'open-session' && typeof d.key === 'string') open(d.key);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [open]);
}

/** 홈 화면 아이콘의 숫자 (지원하는 곳만: 설치된 앱) */
export function setAppBadge(n: number) {
  const nav = navigator as Navigator & { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  (n > 0 ? nav.setAppBadge?.(n) : nav.clearAppBadge?.())?.catch(() => {});
}

// ── 설치 ────────────────────────────────────────────────────────

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
const installListeners = new Set<() => void>();
const emitInstall = () => installListeners.forEach((fn) => fn());
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // 브라우저 기본 배너 대신 "앱 설치" 버튼으로
  deferred = e as BeforeInstallPromptEvent;
  emitInstall();
});
window.addEventListener('appinstalled', () => {
  deferred = null;
  emitInstall();
});

export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** iPhone·iPad (iPadOS 는 Mac 으로 보이므로 터치로 구분) */
export const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** 브라우저가 설치 창을 띄울 수 있을 때만 함수 (Chrome·Edge·Android). iOS 는 공유 → 홈 화면에 추가 */
export function useInstallPrompt(): (() => Promise<void>) | null {
  const can = useSyncExternalStore(
    (fn) => {
      installListeners.add(fn);
      return () => installListeners.delete(fn);
    },
    () => deferred !== null,
  );
  if (!can) return null;
  return async () => {
    const e = deferred;
    if (!e) return;
    await e.prompt();
    await e.userChoice.catch(() => undefined);
    deferred = null;
    emitInstall();
  };
}

// ── 알림 (웹 푸시) ───────────────────────────────────────────────

export type PushState =
  | { kind: 'loading' }
  /** 이 브라우저·서버에서 쓸 수 없음 — why 로 안내 */
  | { kind: 'unsupported'; why: 'browser' | 'ios-install' | 'server' | 'insecure' }
  | { kind: 'denied' }
  | { kind: 'off' }
  | { kind: 'on' };

const b64urlToBytes = (s: string) => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

async function serverKey(): Promise<string | null> {
  const res = await fetch('/api/push/key').catch(() => null);
  if (!res?.ok) return null;
  return ((await res.json()) as { publicKey: string | null }).publicKey;
}

const post = (path: string, body: unknown) =>
  fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function readState(): Promise<PushState> {
  if (!window.isSecureContext) return { kind: 'unsupported', why: 'insecure' };
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  // iOS 는 홈 화면에 추가한 앱에서만 알림을 받는다 (iOS 16.4+)
  if (!supported) return { kind: 'unsupported', why: isIos() && !isStandalone() ? 'ios-install' : 'browser' };
  if (!(await serverKey())) return { kind: 'unsupported', why: 'server' };
  if (Notification.permission === 'denied') return { kind: 'denied' };
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return { kind: 'off' };
  // 브라우저에는 구독이 있어도 서버가 지웠을 수 있다 (다른 계정으로 구독, 오래 실패)
  const res = await post('/api/push/status', { endpoint: sub.endpoint }).catch(() => null);
  const subscribed = res?.ok ? ((await res.json()) as { subscribed: boolean }).subscribed : false;
  return subscribed ? { kind: 'on' } : { kind: 'off' };
}

/** 이 기기에서 알림 받기 켜기. 실패하면 이유를 던진다 */
async function enable(): Promise<void> {
  const key = await serverKey();
  if (!key) throw new Error(t('err.pushNoKey'));
  if ((await Notification.requestPermission()) !== 'granted') throw new Error(t('err.pushDenied'));
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // 서버 키가 바뀌었으면 새로 구독해야 한다
  const same = sub?.options.applicationServerKey && new Uint8Array(sub.options.applicationServerKey).toString() === b64urlToBytes(key).toString();
  if (sub && !same) {
    await sub.unsubscribe().catch(() => {});
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(key) });
  const res = await post('/api/push/subscribe', sub.toJSON());
  if (!res.ok) throw new Error(t('err.pushRegister'));
}

async function disable(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await post('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}

export function usePush(): { state: PushState; busy: boolean; error?: string; toggle: () => Promise<void> } {
  const [state, setState] = useState<PushState>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let live = true;
    readState()
      .then((s) => live && setState(s))
      .catch(() => live && setState({ kind: 'unsupported', why: 'browser' }));
    return () => {
      live = false;
    };
  }, []);

  const toggle = async () => {
    setBusy(true);
    setError(undefined);
    try {
      if (state.kind === 'on') await disable();
      else await enable();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setState(await readState().catch((): PushState => ({ kind: 'unsupported', why: 'browser' })));
    setBusy(false);
  };
  return { state, busy, error, toggle };
}
