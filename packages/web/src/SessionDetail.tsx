import { type ContentKeys, TEXT_LIMIT } from '@bitl/shared/client';
import { CopyField } from './Copy';
import { t, titleLabels } from './i18n';
import { ApprovalBox } from './ApprovalBox';
import type { Approval } from './approvals';
import { displayTitle, type Session, type TimelineItem, type Turn } from '@bitl/shared/session';
import { useEffect, useRef, useState } from 'react';
import { fetchDetail, patchSession, postAction, type SessionDetail as Detail } from './api';
import { localDateTime, localTime, promptText, resumeCommand, SOURCE_LABEL, WAITING_LABEL } from './format';
import { DeleteConfirm } from './SessionCard';
import { type Entry, writeEntry } from './entries';
import { EntryComposer, EntryList, KindChip, useEntries } from './EntryViews';

/**
 * Detail view modes
 * - side: right panel. Doesn't cover the board, so you can keep watching parallel sessions (clicking another card just swaps the content)
 * - wide: a wide centered layer. For a close look at one session, instructions and timeline side by side
 * On mobile (narrow screens) both are full screen.
 */
export type DetailMode = 'side' | 'wide';

/** side panel width — App reserves the same right padding on the board */
export const SIDE_PANEL_CLASS = 'sm:w-[34rem]';
export const SIDE_PANEL_GUTTER = 'sm:pr-[35.5rem]'; // panel width + 1.5rem gap

/** Color of each event's kind label in the timeline (words, not emoji: they render differently per OS and shout) */
const EVENT_TONE: Record<string, string> = {
  prompt: 'text-sky-600 dark:text-sky-400',
  waiting: 'text-red-600 dark:text-red-400',
  error: 'text-red-600 dark:text-red-400',
  turn_end: 'text-amber-600 dark:text-amber-400',
  subagent_start: 'text-violet-600 dark:text-violet-400',
  subagent_end: 'text-violet-600 dark:text-violet-400',
};
const EVENT_TYPES = ['prompt', 'tool_start', 'tool_end', 'waiting', 'turn_end', 'subagent_start', 'subagent_end', 'error', 'session_start', 'session_end', 'progress'] as const;
const eventLabel = (type: string) => ((EVENT_TYPES as readonly string[]).includes(type) ? t(`detail.ev.${type as (typeof EVENT_TYPES)[number]}`) : type);

/** UI strings. Named msg because this file often uses t for turn/timeline items */
const msg = t;

function timelineText(t: TimelineItem): string {
  if (t.tool) return `${t.tool.name}${t.tool.summary ? `: ${t.tool.summary}` : ''}${t.tool.failed && t.text ? ` — ${t.text}` : ''}`;
  if (t.type === 'waiting') return `${WAITING_LABEL[t.waitingReason ?? 'other']}${t.text ? ` — ${t.text}` : ''}`;
  if (t.type === 'session_start') return msg('detail.sessionStart');
  if (t.type === 'session_end') return msg('detail.sessionEnd');
  if (t.type === 'subagent_start') return `${msg('detail.subagentStart')}${t.text ? ` — ${t.text}` : ''}`;
  if (t.type === 'subagent_end') return msg('detail.subagentEnd');
  return (t.type === 'prompt' ? promptText(t.text) : t.text) ?? t.nativeType;
}

function Time({ iso, now }: { iso: string; now: number }) {
  return (
    <time dateTime={iso} title={localDateTime(iso)} className="shrink-0 tabular-nums text-zinc-400">
      {localTime(iso, now)}
    </time>
  );
}

/**
 * Agent response. Long ones are collapsed to 12 lines and expanded with "Show all".
 * The PC adapter truncates at 10,000 characters (shared/prepare.ts TEXT_LIMIT), so responses hitting that limit are marked as truncated
 */
function ResultText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && !open) setOverflows(el.scrollHeight > el.clientHeight + 2);
  }, [text, open]);
  const clipped = text.length >= TEXT_LIMIT - 1 && text.endsWith('…');
  return (
    <div className="mt-2 border-l-2 border-zinc-200 pl-3 dark:border-zinc-700">
      <p ref={ref} className={`whitespace-pre-wrap break-words text-sm text-zinc-600 dark:text-zinc-400 ${open ? '' : 'line-clamp-[12]'}`}>
        {text}
      </p>
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

/** The agent's events, with the person's own entries slotted in at the time they were written */
/**
 * The agent's events, with the person's own entries slotted in at the time they were written.
 * Each row: a small "time · kind" line, then the content across the full width (a time column squeezed the text)
 */
function Timeline({ items, entries, now }: { items: TimelineItem[]; entries: Entry[]; now: number }) {
  if (items.length === 0 && entries.length === 0) return <p className="text-sm text-zinc-400">{msg('detail.noEvents')}</p>;
  const rows = [...items.map((item) => ({ at: item.at, item })), ...entries.map((entry) => ({ at: entry.createdAt, entry }))].sort((a, b) =>
    b.at.localeCompare(a.at),
  );
  return (
    <ol className="space-y-3">
      {rows.map((r, i) =>
        'entry' in r ? (
          <li key={r.entry.id} className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900">
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <Time iso={r.at} now={now} />
              <span>· {msg('detail.ev.entry')}</span>
              <KindChip entry={r.entry} />
            </div>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm text-zinc-800 dark:text-zinc-100">{r.entry.text}</p>
          </li>
        ) : (
          <TimelineRow key={`${r.at}-${i}`} t={r.item} now={now} />
        ),
      )}
    </ol>
  );
}

function TimelineRow({ t, now }: { t: TimelineItem; now: number }) {
  const failed = t.tool?.failed || t.type === 'error';
  // The label already says it: session start/end and a subagent ending carry nothing more; a subagent start shows its task
  const body =
    t.type === 'session_start' || t.type === 'session_end' || t.type === 'subagent_end' ? undefined : t.type === 'subagent_start' ? t.text : timelineText(t);
  return (
    <li>
      <div className="flex items-center gap-1.5 text-xs text-zinc-500">
        <Time iso={t.at} now={now} />
        <span>·</span>
        <span className={`font-medium ${failed ? 'text-red-600 dark:text-red-400' : (EVENT_TONE[t.type] ?? '')}`}>
          {t.tool?.failed ? msg('detail.ev.toolFailed') : eventLabel(t.type)}
        </span>
        {t.agentType && <span className="text-violet-500">[{t.agentType}]</span>}
      </div>
      {body && (
        <p className={`mt-0.5 whitespace-pre-wrap break-words text-sm ${t.tool ? 'font-mono text-[0.8125rem]' : ''} ${failed ? 'text-red-600 dark:text-red-400' : 'text-zinc-700 dark:text-zinc-300'}`}>
          {body}
        </p>
      )}
    </li>
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
  const [tab, setTab] = useState<'turns' | 'timeline' | 'entries'>('turns');
  const [confirmDelete, setConfirmDelete] = useState(false);
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
  const timeline = detail?.timeline ?? [];
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

      {/* Instructions / timeline switch via tabs (same in wide view — read instructions and responses wide, timeline only when needed) */}
      <nav className="border-b border-zinc-200 px-5 dark:border-zinc-800">
        <div className="flex gap-1">
        {(
          [
            ['turns', msg('detail.tabTurns', { n: turns.length })],
            ['timeline', msg('detail.tabTimeline', { n: timeline.length })],
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
      </nav>

      <div className="min-h-0 flex-1">
        {(['turns', 'timeline', 'entries'] as const).map((id) => (
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
            ) : id === 'turns' ? (
              <TurnList turns={turns} now={now} activity={activity} />
            ) : (
              <Timeline items={timeline} entries={entries} now={now} />
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
              onClick={() => postAction(session.key, session.archived ? 'unarchive' : 'archive').then(onClose)}
              className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
            >
              {session.archived ? msg('detail.unarchive') : msg('detail.archive')}
            </button>
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

  if (wide) {
    return (
      <div className="fixed inset-0 z-30 flex items-center justify-center sm:p-6">
        <button type="button" aria-label={msg('detail.close')} onClick={onClose} className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" />
        {panel}
      </div>
    );
  }
  // side: doesn't block the background — the board stays visible and clickable (full screen on mobile)
  return <div className="fixed inset-y-0 right-0 z-30 flex w-full sm:w-auto">{panel}</div>;
}
