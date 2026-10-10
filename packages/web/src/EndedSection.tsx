import { displayTitle, type Session } from '@bitl/shared/client';
import { useEffect, useRef, useState } from 'react';
import { deleteEnded } from './api';
import { localTime, SOURCE_LABEL } from './format';
import { t, titleLabels } from './i18n';

/**
 * The "Ended" section below the four columns — sessions the agent has ended. Always visible, even when empty (so people know it exists as cards pile up).
 * It is unrelated to the current flow, so it is collapsed by default (remembered in this browser);
 * expanded, it shows small one-line title cards. "Clear all" asks once more, then deletes along with history.
 * When filtered by a goal, it gets only that goal's ended cards, and clearing affects only those.
 */
const OPEN_KEY = 'bitl.endedOpen';
const RECENT = 8;

const readOpen = () => {
  try {
    return localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
};

const CHIP: Record<Session['source'], string> = {
  'claude-code': 'bg-orange-100 text-orange-800 dark:bg-orange-500/15 dark:text-orange-300',
  codex: 'bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300',
  antigravity: 'bg-violet-100 text-violet-800 dark:bg-violet-500/15 dark:text-violet-300',
  'claude-desktop': 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  'claude-cloud': 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  manual: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700/50 dark:text-zinc-300',
};

export function EndedSection({
  sessions,
  now,
  onOpen,
  scoped,
  canEdit,
}: {
  /** Ended cards (most recently ended first) */
  sessions: Session[];
  now: number;
  onOpen: (key: string) => void;
  /** true when filtered by a goal — limits clearing to these cards */
  scoped: boolean;
  canEdit: boolean;
}) {
  const [open, setOpen] = useState(readOpen);
  const [all, setAll] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Notice at the bottom after clearing (number deleted) */
  const [done, setDone] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(OPEN_KEY, next ? '1' : '0');
    } catch {
      // this visit only
    }
  };
  const clear = async () => {
    setBusy(true);
    const deleted = await deleteEnded(scoped ? sessions.map((s) => s.key) : undefined).catch(() => -1);
    setBusy(false);
    setConfirm(false);
    setDone(deleted);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setDone(null), 3000);
  };
  const shown = all ? sessions : sessions.slice(0, RECENT);
  const n = sessions.length;

  return (
    <section aria-label={t('ended.title')} className="mt-8 border-t border-zinc-200 pt-4 dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button
          type="button"
          aria-expanded={open && n > 0}
          onClick={toggle}
          disabled={n === 0}
          className="flex items-center gap-2 rounded-md px-1 py-0.5 text-sm font-semibold text-zinc-600 disabled:cursor-default dark:text-zinc-300"
        >
          <span className={`inline-block text-xs transition-transform ${n === 0 ? 'opacity-0' : open ? 'rotate-90' : ''}`}>▸</span>
          <span className="size-2.5 rounded-full bg-zinc-400" />
          {t('ended.title')}
          <span className="font-normal text-zinc-400">{n}</span>
        </button>
        <span className="text-xs text-zinc-500">{n === 0 ? t('ended.hintEmpty') : open ? t('ended.hint') : t('ended.hintClosed')}</span>
        {canEdit && n > 0 && (
          <span className="ml-auto flex flex-wrap items-center gap-2">
            {confirm ? (
              <span className="flex flex-wrap items-center gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-1.5 text-sm dark:border-red-500/40 dark:bg-red-500/10">
                {t('ended.confirm', { n })}
                <button type="button" className="rounded-md border border-zinc-300 bg-white px-2.5 py-0.5 dark:border-zinc-700 dark:bg-zinc-900" onClick={() => setConfirm(false)}>
                  {t('ended.cancel')}
                </button>
                <button type="button" disabled={busy} className="rounded-md bg-red-600 px-2.5 py-0.5 font-semibold text-white disabled:opacity-50" onClick={clear}>
                  {t('ended.confirmYes', { n })}
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setConfirm(true)}
                className="rounded-lg border border-red-300 px-2.5 py-1 text-sm text-red-600 hover:bg-red-50 dark:border-red-500/40 dark:text-red-400 dark:hover:bg-red-500/10"
              >
                {t('ended.clear')}
              </button>
            )}
          </span>
        )}
      </div>

      {done !== null && (
        <div
          role="status"
          className={`fixed bottom-[max(1.5rem,env(safe-area-inset-bottom))] left-1/2 z-50 -translate-x-1/2 rounded-full px-4 py-2 text-sm font-medium shadow-lg ${
            done < 0 ? 'bg-red-600 text-white' : 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
          }`}
        >
          {done < 0 ? t('ended.failed') : `✓ ${t('ended.deleted', { n: done })}`}
        </div>
      )}

      {open && n > 0 && (
        <>
          <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-2">
            {shown.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => onOpen(s.key)}
                className="grid gap-0.5 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-left opacity-85 hover:opacity-100 dark:border-zinc-800 dark:bg-zinc-900/70"
              >
                <span className="flex items-center gap-1.5 text-xs text-zinc-500">
                  <span className={`shrink-0 rounded px-1.5 font-medium ${CHIP[s.source]}`}>{SOURCE_LABEL[s.source]}</span>
                  <span className="min-w-0 truncate font-mono">
                    {s.project ?? ''}
                    {s.gitBranch ? `@${s.gitBranch}` : ''}
                  </span>
                </span>
                <span className="truncate text-sm font-medium">{displayTitle(s, titleLabels())}</span>
                <span className="text-xs text-zinc-500">{t('ended.at', { t: localTime(s.endedAt ?? s.statusAt, now) })}</span>
              </button>
            ))}
          </div>
          {n > RECENT && (
            <p className="mt-2.5 text-sm text-zinc-500">
              {all ? null : t('ended.recent', { k: RECENT })}{' '}
              <button type="button" className="text-sky-600 hover:underline dark:text-sky-400" onClick={() => setAll((v) => !v)}>
                {all ? t('ended.showRecent') : t('ended.showAll', { n })}
              </button>
            </p>
          )}
        </>
      )}
    </section>
  );
}
