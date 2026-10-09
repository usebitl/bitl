import { type ReactNode, createElement, Fragment, useSyncExternalStore } from 'react';
import { en } from './en';
import { ko, type MessageKey } from './ko';

// 화면 문구 다국어. 문구는 ko.ts(기준)·en.ts 에 키로 모은다 — en 은 ko 의 키를 빠짐없이 가져야 컴파일된다.
// 언어: 주소(/ko, /en 소개 페이지) → 사용자가 고른 값(localStorage) → 브라우저 언어. 기본 한국어.
// 컴포넌트 밖(format.ts 등)에서도 t() 를 쓸 수 있게 현재 언어는 모듈 변수로 두고, 바뀌면 useLang() 을 쓰는 루트가 다시 그린다.

export type Lang = 'ko' | 'en';
export const LANGS: readonly Lang[] = ['ko', 'en'];
export const LANG_LABEL: Record<Lang, string> = { ko: '한국어', en: 'English' };

const DICT: Record<Lang, Record<MessageKey, string>> = { ko, en };
const STORAGE_KEY = 'bitl.lang';

const isLang = (v: unknown): v is Lang => v === 'ko' || v === 'en';

/** 주소가 /ko, /en 이면 그 언어 (소개 페이지) */
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
    // 저장소를 못 쓰는 환경
  }
  return (navigator.languages?.[0] ?? navigator.language ?? '').toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

/** 서비스 워커(sw/sw.ts)가 휴대폰 알림을 같은 언어로 쓰게 캐시에 적어 둔다 */
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

/** 언어 바꾸기. remember: 이 브라우저에 기억 (사용자가 직접 고른 경우) */
export function setLang(lang: Lang, remember = true): void {
  if (remember) {
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      // 이번 방문만
    }
  }
  if (lang === current) return;
  current = lang;
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
  shareWithServiceWorker(lang);
  for (const l of listeners) l();
}

/** 현재 언어. 바뀌면 다시 그린다 — 루트에서 한 번 쓰면 아래 컴포넌트의 t() 도 새 언어로 그려진다 */
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

/** 문구. {name} 자리에 vars 값을 넣는다 */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const text = DICT[current][key] ?? ko[key];
  return vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : text;
}

/**
 * 꾸밈이 섞인 문구. 문구 안의 <b>…</b>, <code>…</code> 같은 표시를 tags 의 함수로 감싼다 (겹침 없음).
 * 예) rich('cx.trust', { code: (s) => <code>{s}</code> })
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
