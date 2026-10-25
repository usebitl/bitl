import { type ContentKeys, TEXT_LIMIT } from '@bitl/shared/client';
import { CopyField } from './Copy';
import { t, titleLabels } from './i18n';
import { ApprovalBox } from './ApprovalBox';
import type { Approval } from './approvals';
import { displayTitle, type Session, type Turn } from '@bitl/shared/session';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { fetchDetail, patchSession, type SessionDetail as Detail } from './api';
import { agentReport, localDateTime, localTime, promptText, resumeCommand, SOURCE_LABEL } from './format';
import { DeleteConfirm } from './SessionCard';
import { writeEntry } from './entries';
import { EntryComposer, EntryList, useEntries } from './EntryViews';

/**
 * Detail view modes
 * - side: right panel. Doesn't cover the board, so you can keep watching parallel sessions (clicking another card just swaps the content)
 * - wide: a wide centered layer. For a close look at one session
 * On mobile (narrow screens) both are full screen.
 */
export type DetailMode = 'side' | 'wide';

/** side panel width — App reserves the same right padding on the board */
export const SIDE_PANEL_CLASS = 'sm:w-[34rem]';
export const SIDE_PANEL_GUTTER = 'sm:pr-[35.5rem]'; // panel width + 1.5rem gap

/** UI strings. Named msg because this file often uses t for turns */
const msg = t;

function Time({ iso, now }: { iso: string; now: number }) {
  return (
    <time dateTime={iso} title={localDateTime(iso)} className="shrink-0 tabular-nums text-zinc-400">
      {localTime(iso, now)}
    </time>
  );
}

/** Markdown renderer, loaded on first use so the board's first load doesn't carry it */
const Markdown = lazy(() => import('./Markdown'));

/**
 * Agent response, rendered as Markdown (agents answer in it). Long ones are collapsed to about 12 lines and expanded with "Show all".
 * The PC adapter truncates at 10,000 characters (shared/prepare.ts TEXT_LIMIT), so responses hitting that limit are marked as truncated
 */
function ResultText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    // The Markdown chunk may still be loading — measure again whenever the content's size changes
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 2);
    measure();
    const ro = new ResizeObserver(measure);
    for (const child of el.children) ro.observe(child);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, open]);
  const clipped = text.length >= TEXT_LIMIT - 1 && text.endsWith('…');
  return (
    <div className="mt-2 border-l-2 border-zinc-200 pl-3 dark:border-zinc-700">
      <div ref={ref} className={`break-words text-sm text-zinc-600 dark:text-zinc-400 ${open ? '' : 'max-h-[15rem] overflow-hidden'}`}>
        <div>
          <Suspense fallback={<p className="whitespace-pre-wrap">{text}</p>}>
            <Markdown text={text} />
          </Suspense>
        </div>
      </div>
      {open && clipped && <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-400">{t('detail.clipped', { n: TEXT_LIMIT.toLocaleString() })}</p>}
      {(overflows || open) && (
        <button type="button" onClick={() => setOpen((v) => !v)} className="mt-1.5 text-xs font-medium text-sky-600 hover:underline dark:text-sky-400">
          {open ? t('detail.less') : t('detail.more')}
        </button>
      )}
    </div>
  );
}

/**
 * activity: what the session is doing right now (same as the card). Shown under the newest turn (turns are newest first)
 * while it has no response yet, so the panel isn't blank between the prompt and the answer
 */
function TurnList({ turns, now, activity }: { turns: Turn[]; now: number; activity?: string }) {
  if (turns.length === 0) return <p className="text-sm text-zinc-400">{msg('detail.noTurns')}</p>;
  return (
    <ol className="space-y-4">
      {turns.map((t, i) => (
        <li key={`${t.startedAt}-${i}`} className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
          <div className="mb-1.5 flex items-center gap-2 text-xs">
            <Time iso={t.startedAt} now={now} />
            <span className={t.status === 'error' ? 'text-red-500' : t.status === 'running' ? 'text-emerald-500' : 'text-zinc-400'}>
              {t.status === 'running' ? msg('detail.turnRunning') : t.status === 'error' ? msg('detail.turnError') : msg('detail.turnDone')}
            </span>
            <span className="text-zinc-400">{msg('card.tools', { n: t.toolCount })}</span>
          </div>
          <p className="whitespace-pre-wrap break-words text-sm font-medium">{promptText(t.prompt) ?? msg('detail.noPrompt')}</p>
          {/* A subagent's report came in as the prompt: its text reads like a response, so it's shown like one */}
          {agentReport(t.prompt) && <ResultText text={agentReport(t.prompt)!} />}
          {t.result && <ResultText text={t.result} />}
          {i === 0 && !t.result && activity && (
            <p className="mt-2 break-all border-l-2 border-emerald-300 pl-3 font-mono text-xs text-zinc-600 dark:border-emerald-500/40 dark:text-zinc-400">
              {activity}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}

/** Reading mode: a page with lines of text, the last one short */
function ReaderIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="1.75" width="10" height="12.5" rx="1.75" />
      <path d="M5.75 5.25h4.5M5.75 8h4.5M5.75 10.75h2.5" />
    </svg>
  );
}

/**
 * Focus view: the whole conversation, newest turn at the top (like the turns tab), over the entire window — nothing else on screen.
 * Within a turn the prompt comes before its response. Responses are shown in full (no collapsing).
 * Esc closes only this view and returns to the detail.
 */
function FocusView({ title, turns, now, activity, onClose }: { title: string; turns: Turn[]; now: number; activity?: string; onClose: () => void }) {
  // Capture phase on window runs before the detail's own Escape listener, so stopping here keeps the detail open
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  return (
    <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-50 flex flex-col bg-white dark:bg-zinc-950">
      <header className="flex items-center gap-3 border-b border-zinc-200 px-5 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] dark:border-zinc-800">
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold">{title}</h2>
          <p className="text-xs text-zinc-500">{msg('detail.tabTurns', { n: turns.length })}</p>
        </div>
        <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-100">
          {msg('detail.focusClose')}
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5">
        <ol className="mx-auto max-w-3xl divide-y divide-zinc-200 pb-[max(1rem,env(safe-area-inset-bottom))] dark:divide-zinc-800">
          {turns.length === 0 && <p className="py-8 text-center text-sm text-zinc-400">{msg('detail.noTurns')}</p>}
          {turns.map((t, i) => (
            <li key={`${t.startedAt}-${i}`} className="space-y-4 py-8">
              <div className="flex flex-col items-end">
                <div className="mb-1 flex items-center gap-2 text-xs">
                  {t.status === 'error' && <span className="text-red-500">{msg('detail.turnError')}</span>}
                  <Time iso={t.startedAt} now={now} />
                </div>
                <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-tr-sm bg-zinc-100 px-4 py-2.5 dark:bg-zinc-800">
                  {promptText(t.prompt) ?? msg('detail.noPrompt')}
                </p>
              </div>
              {agentReport(t.prompt) && (
                <div className="break-words border-l-2 border-zinc-200 pl-4 text-[0.9375rem] leading-relaxed text-zinc-700 dark:border-zinc-700 dark:text-zinc-300">
                  <Suspense fallback={<p className="whitespace-pre-wrap">{agentReport(t.prompt)}</p>}>
                    <Markdown text={agentReport(t.prompt)!} />
                  </Suspense>
                </div>
              )}
              {t.result ? (
                <div className="break-words text-[0.9375rem] leading-relaxed text-zinc-700 dark:text-zinc-300">
                  <Suspense fallback={<p className="whitespace-pre-wrap">{t.result}</p>}>
                    <Markdown text={t.result} />
                  </Suspense>
                  {t.result.length >= TEXT_LIMIT - 1 && t.result.endsWith('…') && (
                    <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">{msg('detail.clipped', { n: TEXT_LIMIT.toLocaleString() })}</p>
                  )}
                </div>
              ) : (
                i === 0 &&
                activity && <p className="break-all border-l-2 border-emerald-300 pl-3 font-mono text-xs text-zinc-500 dark:border-emerald-500/40">{activity}</p>
              )}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

interface Props {
  session: Session;
  now: number;
  mode: DetailMode;
  /** Whether other sessions are waiting for you while viewing the detail (wide mode covers the board, so we tell you) */
  attentionCount: number;
  onToggleMode: () => void;
  onClose: () => void;
  /** Remote approval request (this card's oldest) */
  approval?: Approval;
  keys?: ContentKeys | null;
  /** Can write entries (has keys, not read-only) */
  canEdit?: boolean;
}

export function SessionDetail({ session, now, mode, attentionCount, onToggleMode, onClose, approval, keys, canEdit = false }: Props) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [tab, setTab] = useState<'turns' | 'entries'>('turns');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [focus, setFocus] = useState(false);
  const closeFocus = useCallback(() => setFocus(false), []);
  const wide = mode === 'wide';
  const { entries } = useEntries({ session: session.key });
  // Kept with each entry, so it still says where it was written after the card is gone
  const where = { title: displayTitle(session, titleLabels()), project: session.project, branch: session.gitBranch, source: SOURCE_LABEL[session.source] };

  // reload the detail when the session gets new events
  useEffect(() => {
    let alive = true;
    fetchDetail(session.key).then((d) => alive && setDetail(d));
    return () => {
      alive = false;
    };
  }, [session.key, session.lastEventAt, session.turnCount]);

  // The old note becomes the card's first entry (once): entries replace notes
  const moving = useRef(false);
  useEffect(() => {
    if (!session.note || !canEdit || moving.current) return;
    moving.current = true;
    writeEntry({ text: session.note, fromNote: true, where }, session.key)
      .then(() => patchSession(session.key, { note: '' }))
      .catch(() => {
        moving.current = false;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.note, canEdit, session.key]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const resume = resumeCommand(session);
  const turns = detail?.turns ?? [];
  // same rule as the card: what it's doing now while running or waiting
  const activity = session.status === 'running' || session.status === 'waiting_for_you' ? session.currentActivity : undefined;
  // number of other sessions waiting for you
  const othersWaiting = attentionCount - (session.status === 'waiting_for_you' || session.status === 'error' ? 1 : 0);

  const panel = (
    <aside
      className={[
        'relative flex w-full flex-col overflow-hidden bg-white shadow-2xl dark:bg-zinc-950',
        wide
          ? 'h-full sm:h-[88vh] sm:max-w-6xl sm:rounded-2xl sm:border sm:border-zinc-200 sm:dark:border-zinc-800'
          : `h-full border-zinc-200 sm:border-l dark:border-zinc-800 ${SIDE_PANEL_CLASS}`,
      ].join(' ')}
    >
      {wide && othersWaiting > 0 && (
        <button
          type="button"
          onClick={onClose}
          className="bg-red-500 px-5 py-1.5 text-left text-sm font-medium text-white hover:bg-red-600"
        >
          {msg('detail.othersWaiting', { n: othersWaiting })}
        </button>
      )}

      <header className="border-b border-zinc-200 px-5 pb-4 pt-[max(1rem,env(safe-area-inset-top))] dark:border-zinc-800">
        <div className="flex items-start gap-1">
          <div className="min-w-0 flex-1 pr-2">
            <div className="mb-1 truncate font-mono text-xs text-zinc-500">
              {SOURCE_LABEL[session.source]} · {session.project ?? '?'}
              {session.gitBranch && ` @${session.gitBranch}`}
            </div>
            <h2 className="text-lg font-bold leading-snug">{displayTitle(session, titleLabels())}</h2>
          </div>
          <button
            type="button"
            onClick={() => patchSession(session.key, { pinned: !session.pinned })}
            className={`rounded-lg px-2 py-1 text-lg ${session.pinned ? '' : 'opacity-30 hover:opacity-70'}`}
            title={session.pinned ? msg('detail.unpin') : msg('detail.pin')}
          >
            📌
          </button>
          <button
            type="button"
            onClick={onToggleMode}
            className="hidden rounded-lg px-2 py-1 text-lg text-zinc-400 hover:text-zinc-700 sm:block dark:hover:text-zinc-200"
            title={wide ? msg('detail.sideMode') : msg('detail.wideMode')}
          >
            {wide ? '⇥' : '⤢'}
          </button>
          <button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-xl text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200" title={msg('detail.closeEsc')}>
            ✕
          </button>
        </div>

        <div className="mt-2">
          <div className="space-y-2">
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
              <span>
                {msg('detail.started')} <Time iso={session.startedAt} now={now} />
              </span>
              <span>
                {msg('detail.lastActive')} <Time iso={session.lastEventAt} now={now} />
              </span>
              <span>
                {msg('card.turns', { n: session.turnCount })} · {msg('card.tools', { n: session.toolCount })}
              </span>
            </div>
            {resume && (
              <CopyField text={resume} />
            )}
          </div>
        </div>
        {approval && <ApprovalBox approval={approval} keys={keys} now={now} full />}
      </header>

      {/* Turns / entries switch via tabs (same in wide view) */}
      <nav className="flex items-center border-b border-zinc-200 px-5 dark:border-zinc-800">
        <div className="flex min-w-0 gap-1">
        {(
          [
            ['turns', msg('detail.tabTurns', { n: turns.length })],
            ['entries', msg('detail.tabEntries', { n: entries.length })],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === id ? 'border-zinc-900 font-semibold dark:border-zinc-100' : 'border-transparent text-zinc-500'}`}
          >
            {label}
          </button>
        ))}
        </div>
        {/* Focus view sits with the content it shows, not with the panel controls in the header */}
        <button
          type="button"
          onClick={() => setFocus(true)}
          title={msg('detail.focus')}
          aria-label={msg('detail.focus')}
          className="ml-auto flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
        >
          <ReaderIcon />
          <span className="hidden sm:inline">{msg('detail.focusShort')}</span>
        </button>
      </nav>

      <div className="min-h-0 flex-1">
        {(['turns', 'entries'] as const).map((id) => (
          <section
            key={id}
            className={['h-full overflow-y-auto px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]', tab === id ? '' : 'hidden'].join(' ')}
          >
            {/* Wide view: the body stays left-aligned with the tabs, at most about 900px so lines don't get too long */}
            <div className={wide ? 'max-w-[900px]' : undefined}>
            {id === 'entries' ? (
              <div className="space-y-4">
                <EntryComposer sessionKey={session.key} where={where} canEdit={canEdit} placeholder={msg('entry.placeholderCard')} />
                <EntryList entries={entries} now={now} canEdit={canEdit} empty={msg('entry.emptyCard')} />
              </div>
            ) : !detail ? (
              <p className="text-sm text-zinc-400">{msg('detail.loading')}</p>
            ) : (
              <TurnList turns={turns} now={now} activity={activity} />
            )}
            </div>
          </section>
        ))}
      </div>

      <footer className="border-t border-zinc-200 px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] dark:border-zinc-800">
        {confirmDelete ? (
          <div className="-mt-3">
            <DeleteConfirm s={session} onCancel={() => setConfirmDelete(false)} onDeleted={onClose} />
          </div>
        ) : (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="ml-auto rounded-lg border border-red-200 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:border-red-500/30 dark:text-red-400 dark:hover:bg-red-500/10"
            >
              {msg('card.delete')}
            </button>
          </div>
        )}
      </footer>
    </aside>
  );

  const focusView = focus && (
    <FocusView title={displayTitle(session, titleLabels())} turns={turns} now={now} activity={activity} onClose={closeFocus} />
  );

  if (wide) {
    return (
      <div className="fixed inset-0 z-30 flex items-center justify-center sm:p-6">
        <button type="button" aria-label={msg('detail.close')} onClick={onClose} className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" />
        {panel}
        {focusView}
      </div>
    );
  }
  // side: doesn't block the background — the board stays visible and clickable (full screen on mobile)
  return (
    <div className="fixed inset-y-0 right-0 z-30 flex w-full sm:w-auto">
      {panel}
      {focusView}
    </div>
  );
}
