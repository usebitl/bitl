import { type ReactNode, createElement, Fragment, useSyncExternalStore } from 'react';
import { en } from './en';
import { ko, type MessageKey } from './ko';

// UI string i18n. Strings are keyed in ko.ts (the reference) and en.ts — en must have every ko key to compile.
// Language: URL (/ko, /en landing pages) → user choice (localStorage) → browser language. Default Korean.
// The current language is a module variable so t() works outside components (format.ts, etc.); when it changes, the root using useLang() re-renders.

export type Lang = 'ko' | 'en';
export const LANGS: readonly Lang[] = ['ko', 'en'];
export const LANG_LABEL: Record<Lang, string> = { ko: '한국어', en: 'English' };

const DICT: Record<Lang, Record<MessageKey, string>> = { ko, en };
const STORAGE_KEY = 'bitl.lang';

const isLang = (v: unknown): v is Lang => v === 'ko' || v === 'en';

/** The language from a /ko or /en URL (landing pages) */
export function langFromPath(path: string): Lang | undefined {
  const m = /^\/(ko|en)\/?$/.exec(path);
  return m ? (m[1] as Lang) : undefined;
}

function detect(): Lang {
  if (typeof window === 'undefined') return 'ko';
  const fromPath = langFromPath(window.location.pathname);
  if (fromPath) return fromPath;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLang(saved)) return saved;
  } catch {
    // storage unavailable
  }
  return (navigator.languages?.[0] ?? navigator.language ?? '').toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

/** Written to the cache so the service worker (sw/sw.ts) uses the same language for phone notifications */
function shareWithServiceWorker(lang: Lang): void {
  if (typeof caches === 'undefined') return;
  caches
    .open('bitl.prefs')
    .then((c) => c.put('/lang', new Response(lang)))
    .catch(() => {});
}

let current: Lang = detect();
const listeners = new Set<() => void>();
if (typeof document !== 'undefined') document.documentElement.lang = current;
shareWithServiceWorker(current);

export const getLang = (): Lang => current;

/** Change language. remember: remember in this browser (when the user chose it) */
export function setLang(lang: Lang, remember = true): void {
  if (remember) {
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      // this visit only
    }
  }
  if (lang === current) return;
  current = lang;
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
  shareWithServiceWorker(lang);
  for (const l of listeners) l();
}

/** Current language; re-renders on change — used once at the root, t() in components below renders in the new language too */
export function useLang(): Lang {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getLang,
    getLang,
  );
}

/** A string. Substitutes vars values into {name} placeholders */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const text = DICT[current][key] ?? ko[key];
  // {s} is the English plural ending for {n}: "{n} turn{s}" → "1 turn", "2 turns"
  const all = vars && 'n' in vars ? { s: vars.n === 1 ? '' : 's', ...vars } : vars;
  return all ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in all ? String(all[k]) : m)) : text;
}

/**
 * A string with markup. Wraps marks like <b>…</b> and <code>…</code> in the string with the functions in tags (no nesting).
 * e.g. rich('cx.trust', { code: (s) => <code>{s}</code> })
 */
export function rich(key: MessageKey, tags: Record<string, (text: string) => ReactNode>, vars?: Record<string, string | number>): ReactNode {
  const parts: ReactNode[] = [];
  const text = t(key, vars);
  const re = /<(\w+)>([\s\S]*?)<\/\1>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const wrap = tags[m[1]!];
    parts.push(createElement(Fragment, { key: parts.length }, wrap ? wrap(m[2]!) : m[2]));
    last = re.lastIndex;
  }
  if (last < text.length) parts.push(text.slice(last));
  return createElement(Fragment, null, ...parts);
}

export type { MessageKey };

/** Fallback card titles for displayTitle() in the current language */
export const titleLabels = () => ({ locked: t('card.locked'), untitled: t('card.untitled') });
