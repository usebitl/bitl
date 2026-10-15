import { type BoardColumn, columnOf, type ContentKeys, isEmptySession, type Session } from '@bitl/shared/client';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApprovalBox } from './ApprovalBox';
import type { Approval } from './approvals';
import { setAppBadge, useOpenFromNotification } from './pwa';
import { Logo } from './Logo';
import { SessionCard } from './SessionCard';
import { type DetailMode, SessionDetail, SIDE_PANEL_GUTTER } from './SessionDetail';
import { type Connection, useNow, useSessions } from './useSessions';
import { rich, t } from './i18n';
import { GlobeIcon } from './Icons';
import { EndedSection } from './EndedSection';
import { GoalDialog, GoalFilter, GoalsBar, goalSessions, PlusIcon } from './GoalViews';
import type { Goal } from './goals';
import { LangSwitch } from './LangSwitch';

const COLUMNS: { id: BoardColumn; dot: string }[] = [
  { id: 'attention', dot: 'bg-red-500' },
  { id: 'running', dot: 'bg-emerald-500' },
  { id: 'review', dot: 'bg-amber-400' },
  { id: 'rest', dot: 'bg-zinc-400' },
];

/** Pinned cards first. Then tasks waiting for you, longest-waiting first; the rest by most recent activity */
function sortFor(col: BoardColumn) {
  const byTime =
    col === 'attention'
      ? (a: Session, b: Session) => a.statusAt.localeCompare(b.statusAt)
      : (a: Session, b: Session) => b.lastEventAt.localeCompare(a.lastEventAt);
  return (a: Session, b: Session) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || byTime(a, b);
}

/**
 * The detail view opens via the URL hash (#s=<key>) — so Back closes it in mobile webviews.
 * Tapping another card while it is open replaces the entry instead of pushing one, so a single Back returns to the board.
 */
function useSelectedKey(): [string | null, (key: string | null) => void] {
  const read = () => {
    const m = /^#s=(.+)$/.exec(window.location.hash);
    return m?.[1] ? decodeURIComponent(m[1]) : null;
  };
  const [key, setKey] = useState(read);
  const pushed = useRef(false); // whether we pushed a history entry (false when opened directly via the URL)
  useEffect(() => {
    const onHash = () => {
      const k = read();
      if (!k) pushed.current = false;
      setKey(k);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const select = useCallback((next: string | null) => {
    const base = window.location.pathname + window.location.search;
    if (next) {
      const hash = `#s=${encodeURIComponent(next)}`;
      if (read()) history.replaceState(null, '', base + hash);
      else {
        history.pushState(null, '', base + hash);
        pushed.current = true;
      }
      setKey(next);
    } else if (read()) {
      if (pushed.current) history.back(); // hashchange clears key
      else {
        history.replaceState(null, '', base);
        setKey(null);
      }
    }
  }, []);
  return [key, select];
}

/**
 * Shown only when the live connection has a problem (a normal connection is not shown).
 * Appears only after more than 3 seconds, so the initial connect or a brief reconnect does not flicker
 */
function useConnectionIssue(connection: Connection): 'connecting' | 'offline' | null {
  const [shown, setShown] = useState<'connecting' | 'offline' | null>(null);
  useEffect(() => {
    if (connection === 'live') {
      setShown(null);
      return;
    }
    const timer = setTimeout(() => setShown(connection), 3000);
    return () => clearTimeout(timer);
  }, [connection]);
  return shown;
}

const MODE_STORAGE_KEY = 'bitl.detailMode';

/** Remembers the detail view mode (right panel / wide) in this browser */
function useDetailMode(): [DetailMode, () => void] {
  const [mode, setMode] = useState<DetailMode>(() => {
    try {
      return localStorage.getItem(MODE_STORAGE_KEY) === 'wide' ? 'wide' : 'side';
    } catch {
      return 'side';
    }
  });
  const toggle = useCallback(() => {
    setMode((m) => {
      const next = m === 'side' ? 'wide' : 'side';
      try {
        localStorage.setItem(MODE_STORAGE_KEY, next);
      } catch {
        // storage unavailable (private mode, etc.) — keep for this session only
      }
      return next;
    });
  }, []);
  return [mode, toggle];
}

/**
 * Things to plug into the board — local mode passes none.
 * Other servers (with sign-in and device pairing) add notices, menu items and dialogs here.
 */
export interface BoardProps {
  /** This browser's content keys (undefined: loading, null: none — card contents show 🔒) */
  keys: ContentKeys | null | undefined;
  /** Whether cards may start loading (false before sign-in). Default true */
  enabled?: boolean;
  /** Cannot create or edit (goals) */
  readonly?: boolean;
  /** Next to the logo (the cloud site's beta badge) */
  badge?: ReactNode;
  /** Notice line below the header */
  banners?: ReactNode;
  /** 🔒 notice. showWhenNoKeys: shown when there are no keys (default true); hint: trailing explanation (default: bitl pair instructions) */
  lockedNotice?: { showWhenNoKeys?: boolean; hint?: ReactNode };
  /** Above the card columns (first-time user guidance, etc.) */
  top?: (sessions: Session[]) => ReactNode;
  /** ☰ menu: items go before the language switch, footer after it. close() closes the menu. dot: a dot on the menu button */
  menu?: { items?: (close: () => void) => ReactNode; footer?: (close: () => void) => ReactNode; dot?: boolean };
  /** Dialogs opened over the board */
  overlays?: ReactNode;
}

/** ☰ menu item style (shared by button and a) */
export const MENU_ITEM = 'flex w-full items-center gap-3 px-4 py-3 text-left text-sm text-zinc-700 active:bg-zinc-100 dark:text-zinc-200 dark:active:bg-zinc-800';
export const MENU_ICON = 'size-[18px] text-zinc-500 dark:text-zinc-400';

export function Board({ keys, enabled = true, readonly = false, badge, banners, lockedNotice, top, menu, overlays }: BoardProps) {
  const { sessions, approvals, goals, connection } = useSessions(enabled ? keys : undefined);
  // Goals: selecting one shows only its cards. Dialog: create (preselect: cards to include from the start) or edit
  const [goalId, setGoalId] = useState<string | null>(null);
  const [goalDialog, setGoalDialog] = useState<{ goal?: Goal; preselect?: string[] } | null>(null);
  const activeGoal = goalId ? goals.find((g) => g.id === goalId) : undefined;
  // Remote approval: the longest-waiting request per card
  const approvalFor = useMemo(() => {
    const map = new Map<string, Approval>();
    for (const a of [...approvals].sort((x, y) => x.createdAt.localeCompare(y.createdAt))) if (!map.has(a.sessionKey)) map.set(a.sessionKey, a);
    return map;
  }, [approvals]);
  // Requests with no card on the board (card not arrived yet, or hidden as archived/ended) — shown separately on top so they are not missed
  const orphanApprovals = useMemo(() => {
    const shown = new Set(sessions.filter((s) => !s.archived && s.status !== 'ended').map((s) => s.key));
    return [...approvalFor.values()].filter((a) => !shown.has(a.sessionKey));
  }, [approvalFor, sessions]);
  const now = useNow();
  const connIssue = useConnectionIssue(connection);
  const [selectedKey, select] = useSelectedKey();
  const [mode, toggleMode] = useDetailMode();

  const byColumn = useMemo(() => {
    const map: Record<BoardColumn, Session[]> = { attention: [], running: [], review: [], rest: [] };
    // When filtered by a goal, only its cards. Ended cards go in the "Ended" section below, not the columns.
    // Sessions that never got a prompt stay off the board (still reachable by link)
    const members = activeGoal ? new Set(activeGoal.members) : null;
    for (const s of sessions) {
      if (s.archived || s.status === 'ended' || isEmptySession(s) || (members && !members.has(s.key))) continue;
      map[columnOf(s.status)].push(s);
    }
    for (const col of COLUMNS) map[col.id].sort(sortFor(col.id));
    return map;
  }, [sessions, activeGoal]);
  const ended = useMemo(() => {
    const members = activeGoal ? new Set(activeGoal.members) : null;
    return sessions
      .filter((s) => !s.archived && s.status === 'ended' && !isEmptySession(s) && (!members || members.has(s.key)))
      .sort((a, b) => (b.endedAt ?? b.statusAt).localeCompare(a.endedAt ?? a.statusAt));
  }, [sessions, activeGoal]);
  // Even while filtered by a goal, the "waiting for you" count (title, badge, notifications) covers everything
  const attentionAll = useMemo(() => sessions.filter((s) => !s.archived && columnOf(s.status) === 'attention').length, [sessions]);
  // Clear the filter when the selected goal is finished or deleted
  useEffect(() => {
    if (goalId && !activeGoal) setGoalId(null);
  }, [goalId, activeGoal, goals]);

  const selected = selectedKey ? sessions.find((s) => s.key === selectedKey) : undefined;
  const attention = attentionAll;
  useOpenFromNotification(select);
  const lockedCount = useMemo(() => sessions.filter((s) => s.locked).length, [sessions]);
  // Creating/editing goals: when keys exist and not read-only
  const canEdit = Boolean(keys) && !readonly;
  const showLocked = (keys === null && lockedNotice?.showWhenNoKeys !== false) || lockedCount > 0;

  useEffect(() => {
    document.title = attention ? `(${attention}) BITL` : 'BITL';
    setAppBadge(attention);
  }, [attention]);

  return (
    // When the side panel opens, the board shifts aside by the panel width and stays visible
    <div className={`px-4 pb-10 sm:px-6 ${selected && mode === 'side' ? SIDE_PANEL_GUTTER : 'mx-auto max-w-[1600px]'}`}>
      <header className="sticky top-0 z-10 -mx-4 mb-4 flex flex-wrap items-center gap-3 border-b border-zinc-200 bg-zinc-50/90 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur sm:-mx-6 sm:px-6 dark:border-zinc-800 dark:bg-[#0b0d12]/90">
        <h1 className="text-lg font-bold tracking-tight">
          <a href="/" className="flex items-center gap-2">
            <Logo size={24} />
            BITL {badge} <span className="hidden font-normal text-zinc-500 md:inline">· Being In The Loop</span>
          </a>
        </h1>
        {attention > 0 && (
          <span className="whitespace-nowrap rounded-full bg-red-500 px-2.5 py-0.5 text-sm font-semibold text-white">
            <span className="sm:hidden">{t('app.waitingShort', { n: attention })}</span>
            <span className="hidden sm:inline">{t('app.waitingLong', { n: attention })}</span>
          </span>
        )}
        {/* Only the essentials on one line (connection issues, goals); the rest goes in the ☰ menu — same layout on PC and phone. Remote approval being on is also shown inside the menu */}
        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          {connIssue && (
            <span className="flex items-center gap-1.5 text-sm" title={connIssue === 'connecting' ? t('app.conn.connecting') : t('app.conn.down')}>
              <span className={`size-2 rounded-full ${connIssue === 'connecting' ? 'bg-amber-400' : 'bg-red-500'}`} />
              <span className={`hidden sm:inline ${connIssue === 'offline' ? 'text-red-600 dark:text-red-400' : 'text-zinc-500'}`}>
                {connIssue === 'connecting' ? t('app.conn.connecting') : t('app.conn.down')}
              </span>
            </span>
          )}
          <button
            type="button"
            disabled={!canEdit}
            title={keys ? t('goal.addLong') : t('app.needKey')}
            onClick={() => setGoalDialog({})}
            className="flex h-8 items-center justify-center gap-1 rounded-lg border border-zinc-300 px-2.5 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-800"
          >
            <PlusIcon />
            {t('goal.add')}
          </button>
          <AppMenu {...menu} />
        </div>
        {banners}
        {showLocked && (
          <p className="basis-full rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
            🔒 {keys === null ? t('app.locked.none') : t('app.locked.some', { n: lockedCount })}{' '}
            {lockedNotice?.hint ?? rich('app.locked.local', { code: (c) => <code className="rounded bg-amber-100 px-1 dark:bg-amber-500/20">{c}</code> })}
          </p>
        )}
      </header>

      {/* Column count follows the board width, not the screen (container query) — it shrinks naturally when the panel opens */}
      {top?.(sessions)}

      {orphanApprovals.length > 0 && (
        <section className="mb-4 space-y-2">
          {orphanApprovals.map((a) => (
            <ApprovalBox key={a.id} approval={a} keys={keys} now={now} full />
          ))}
        </section>
      )}

      <GoalsBar goals={goals} sessions={sessions} selected={activeGoal?.id ?? null} onSelect={setGoalId} onCreate={() => canEdit && setGoalDialog({})} />
      {activeGoal && (
        <GoalFilter
          goal={activeGoal}
          count={goalSessions(activeGoal, sessions).length}
          onEdit={() => setGoalDialog({ goal: activeGoal })}
          onClear={() => setGoalId(null)}
        />
      )}

      <main className="@container">
        <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-2 @5xl:grid-cols-4">
        {COLUMNS.map((col) => (
          <section key={col.id} className="min-w-0">
            <h2 className="mb-2 flex items-center gap-2 px-1 text-sm font-semibold text-zinc-600 dark:text-zinc-300">
              <span className={`size-2.5 rounded-full ${col.dot}`} />
              {t(`app.col.${col.id}`)}
              <span className="font-normal text-zinc-400">{byColumn[col.id].length}</span>
            </h2>
            <div className="space-y-2.5">
              {byColumn[col.id].map((s) => (
                <SessionCard
                  key={s.key}
                  s={s}
                  now={now}
                  selected={s.key === selectedKey}
                  onOpen={() => select(s.key)}
                  approval={approvalFor.get(s.key)}
                  keys={keys}
                  goals={canEdit || goals.length ? goals : undefined}
                  onNewGoal={canEdit ? () => setGoalDialog({ preselect: [s.key] }) : undefined}
                />
              ))}
              {byColumn[col.id].length === 0 && (
                <p className="rounded-xl border border-dashed border-zinc-200 px-3 py-6 text-center text-sm text-zinc-400 dark:border-zinc-800">{activeGoal ? t('goal.emptyCol') : t(`app.col.${col.id}.empty`)}</p>
              )}
            </div>
          </section>
        ))}
        </div>
      </main>

      <EndedSection sessions={ended} now={now} onOpen={select} scoped={Boolean(activeGoal)} canEdit={canEdit} />

      {goalDialog && (
        <GoalDialog
          goal={goalDialog.goal}
          preselect={goalDialog.preselect}
          sessions={sessions}
          onClose={() => setGoalDialog(null)}
          onDeleted={() => setGoalId(null)}
        />
      )}

      {overlays}

      {selected && (
        <SessionDetail
          key={selected.key}
          session={selected}
          now={now}
          mode={mode}
          attentionCount={attention}
          onToggleMode={toggleMode}
          onClose={() => select(null)}
          approval={approvalFor.get(selected.key)}
          keys={keys}
        />
      )}
    </div>
  );
}

/** The header ☰ menu (same on PC and phone): plugged-in items and language */
function AppMenu({ items, footer, dot = false }: NonNullable<BoardProps['menu']>) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button
        type="button"
        aria-label={t('app.menu')}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="relative flex size-8 items-center justify-center rounded-lg text-xl text-zinc-600 dark:text-zinc-300"
      >
        ☰
        {dot && <span className="absolute right-0.5 top-0.5 size-2 rounded-full bg-sky-400" />}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={close} />
          <div className="absolute right-3 top-full z-30 mt-1 w-64 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-900" role="menu">
            {items?.(close)}
            <div className="flex items-center gap-3 px-4 py-2.5 text-sm text-zinc-700 dark:text-zinc-200">
              <GlobeIcon className={MENU_ICON} />
              <span className="flex-1">{t('common.lang')}</span>
              <LangSwitch />
            </div>
            {footer?.(close)}
          </div>
        </>
      )}
    </>
  );
}
