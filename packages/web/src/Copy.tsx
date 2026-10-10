import { useEffect, useRef, useState } from 'react';
import { t } from './i18n';

/**
 * Copy — same look and same notice across the whole app (unified 2026-10-04).
 * Clicking anywhere on a box holding a command or link copies it; the copy icon on the right turns into a green check for 2 seconds and a notice appears at the bottom of the screen.
 */

/** Copy to the clipboard. Falls back to the legacy method where the Clipboard API is missing or blocked (http, some webviews) */
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

/** Copies and remembers the result for 2 seconds */
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

/** Copy result notice (bottom center of the screen) */
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

/** Overlapping squares (copy) ↔ check (copied) */
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
 * A one-line command or link + copy. The whole box is the button (so you don't have to hit a tiny icon on a phone).
 * wrap: wrap long links so they are fully visible (default is one line, scrolling horizontally on overflow)
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
