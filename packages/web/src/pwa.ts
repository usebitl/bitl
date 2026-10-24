import { useEffect, useState, useSyncExternalStore } from 'react';
import { t } from './i18n';

/**
 * Home screen app (PWA) and "waiting for you" notifications.
 * The service worker is sw/sw.ts (built to /sw.js). Not registered on the dev server (vite dev).
 */

export function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('Service worker registration failed:', err));
  });
}

/** Clicking a notification sends the card key to the open app → it opens that card's detail */
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

/** Number on the home screen icon (where supported: installed apps) */
export function setAppBadge(n: number) {
  const nav = navigator as Navigator & { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  (n > 0 ? nav.setAppBadge?.(n) : nav.clearAppBadge?.())?.catch(() => {});
}

// ── Install ────────────────────────────────────────────────────────

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
const installListeners = new Set<() => void>();
const emitInstall = () => installListeners.forEach((fn) => fn());
// Guarded: site pages that show install steps are also pre-rendered at build time, where there is no window
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // use our "Install app" button instead of the browser's default banner
    deferred = e as BeforeInstallPromptEvent;
    emitInstall();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    emitInstall();
  });
}

export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** iPhone/iPad (iPadOS reports as Mac, so detect by touch) */
export const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** A function only when the browser can show an install prompt (Chrome, Edge, Android). On iOS: Share → Add to Home Screen */
export function useInstallPrompt(): (() => Promise<void>) | null {
  const can = useSyncExternalStore(
    (fn) => {
      installListeners.add(fn);
      return () => installListeners.delete(fn);
    },
    () => deferred !== null,
    () => false,
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

// ── Notifications (web push) ───────────────────────────────────────

export type PushState =
  | { kind: 'loading' }
  /** Not available in this browser/server — explained by why */
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
  // iOS only delivers notifications to apps added to the home screen (iOS 16.4+)
  if (!supported) return { kind: 'unsupported', why: isIos() && !isStandalone() ? 'ios-install' : 'browser' };
  if (!(await serverKey())) return { kind: 'unsupported', why: 'server' };
  if (Notification.permission === 'denied') return { kind: 'denied' };
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return { kind: 'off' };
  // the browser may have a subscription the server has dropped (subscribed under another account, repeated failures)
  const res = await post('/api/push/status', { endpoint: sub.endpoint }).catch(() => null);
  const subscribed = res?.ok ? ((await res.json()) as { subscribed: boolean }).subscribed : false;
  return subscribed ? { kind: 'on' } : { kind: 'off' };
}

/** Turns on notifications on this device. Throws the reason on failure */
async function enable(): Promise<void> {
  const key = await serverKey();
  if (!key) throw new Error(t('err.pushNoKey'));
  if ((await Notification.requestPermission()) !== 'granted') throw new Error(t('err.pushDenied'));
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // if the server key changed, we must resubscribe
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
