import { useEffect, useRef, useState } from 'react';
import { t } from './i18n';

/**
 * 복사 — 앱 전체에서 같은 모양·같은 알림으로 (2026-10-04 통일).
 * 명령·링크가 든 상자 전체를 누르면 복사되고, 오른쪽 복사 아이콘이 2초 동안 초록 체크로 바뀌며 화면 아래에 안내가 뜬다.
 */

/** 클립보드에 복사. Clipboard API 가 없거나 막힌 곳(http, 일부 웹뷰)은 예전 방식으로 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

export type CopyState = 'idle' | 'ok' | 'fail';

/** 복사하고 결과를 2초 동안 기억한다 */
export function useCopy(): [state: CopyState, copy: (text: string) => void] {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = (text: string) =>
    void copyText(text).then((ok) => {
      setState(ok ? 'ok' : 'fail');
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setState('idle'), 2000);
    });
  return [state, copy];
}

/** 복사 결과 안내 (화면 아래 가운데) */
export function CopyToast({ state }: { state: CopyState }) {
  if (state === 'idle') return null;
  return (
    <div
      role="status"
      className={`fixed bottom-[max(1.5rem,env(safe-area-inset-bottom))] left-1/2 z-[60] -translate-x-1/2 whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium shadow-lg ${
        state === 'ok' ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : 'bg-red-600 text-white'
      }`}
    >
      {state === 'ok' ? `✓ ${t('common.copiedToast')}` : t('common.copyFailed')}
    </div>
  );
}

/** 겹친 네모(복사) ↔ 체크(복사됨) */
export function CopyIcon({ done, className = 'size-4' }: { done?: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={`shrink-0 ${className}`} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      {done ? (
        <path d="M5 12.5l4.5 4.5L19 7.5" />
      ) : (
        <>
          <rect x="8.5" y="8.5" width="12" height="12" rx="2" />
          <path d="M15.5 8.5V5.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3" />
        </>
      )}
    </svg>
  );
}

/**
 * 명령·링크 한 줄 + 복사. 상자 전체가 버튼이다 (휴대폰에서 작은 아이콘을 맞추지 않아도 되게).
 * wrap: 긴 링크는 줄바꿈해서 다 보이게 (기본은 한 줄, 넘치면 가로 스크롤)
 */
export function CopyField({ text, wrap = false, className = '' }: { text: string; wrap?: boolean; className?: string }) {
  const [state, copy] = useCopy();
  return (
    <>
      <button
        type="button"
        onClick={() => copy(text)}
        title={t('common.copy')}
        aria-label={`${t('common.copy')}: ${text}`}
        className={`group flex w-full items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-left hover:border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800/60 dark:hover:border-zinc-600 dark:hover:bg-zinc-800 ${className}`}
      >
        <code className={`min-w-0 flex-1 font-mono text-[0.82rem] ${wrap ? 'break-all' : 'overflow-x-auto whitespace-nowrap'}`}>{text}</code>
        <span className={state === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-400 group-hover:text-zinc-700 dark:group-hover:text-zinc-200'}>
          <CopyIcon done={state === 'ok'} />
        </span>
      </button>
      <CopyToast state={state} />
    </>
  );
}
