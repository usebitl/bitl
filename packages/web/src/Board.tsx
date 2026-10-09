import { type BoardColumn, columnOf, type ContentKeys, type Session } from '@bitl/shared/client';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApprovalBox } from './ApprovalBox';
import type { Approval } from './approvals';
import { setAppBadge, useOpenFromNotification } from './pwa';
import { Logo } from './Logo';
import { SessionCard } from './SessionCard';
import { type DetailMode, SessionDetail, SIDE_PANEL_GUTTER } from './SessionDetail';
import { type Connection, useNow, useSessions } from './useSessions';
import { rich, t } from './i18n';
import { BetaBadge } from './BetaBadge';
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

/** 고정한 카드가 먼저. 그다음 나를 기다리는 작업은 오래 기다린 순, 나머지는 최근 활동 순 */
function sortFor(col: BoardColumn) {
  const byTime =
    col === 'attention'
      ? (a: Session, b: Session) => a.statusAt.localeCompare(b.statusAt)
      : (a: Session, b: Session) => b.lastEventAt.localeCompare(a.lastEventAt);
  return (a: Session, b: Session) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || byTime(a, b);
}

/**
 * 상세는 URL hash(#s=<key>)로 연다 — 모바일 웹뷰에서 뒤로 가기로 닫힌다.
 * 열린 상태에서 다른 카드를 누르면 기록을 쌓지 않고 바꿔치기해서, 뒤로 가기 한 번이면 보드로 돌아온다.
 */
function useSelectedKey(): [string | null, (key: string | null) => void] {
  const read = () => {
    const m = /^#s=(.+)$/.exec(window.location.hash);
    return m?.[1] ? decodeURIComponent(m[1]) : null;
  };
  const [key, setKey] = useState(read);
  const pushed = useRef(false); // 우리가 기록을 하나 쌓았는지 (주소로 바로 열린 경우는 false)
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
      if (pushed.current) history.back(); // hashchange 가 key 를 비운다
      else {
        history.replaceState(null, '', base);
        setKey(null);
      }
    }
  }, []);
  return [key, select];
}

/**
 * 실시간 연결에 문제가 있을 때만 알린다 (평소 연결됨은 표시하지 않는다).
 * 처음 연결·잠깐의 재연결로 깜빡이지 않게 3초 넘게 이어질 때만 보인다
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

/** 상세 보기 방식(오른쪽 패널 / 넓게)을 이 브라우저에 기억한다 */
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
        // 저장 불가(사생활 보호 모드 등) — 이번 세션만 유지
      }
      return next;
    });
  }, []);
  return [mode, toggle];
}

/**
 * 보드에 끼울 것 — 로컬 모드는 아무것도 넘기지 않는다.
 * 다른 서버(로그인·기기 연결이 있는 곳)는 여기에 안내·메뉴 항목·창을 더한다.
 */
export interface BoardProps {
  /** 이 브라우저의 내용 키 (undefined: 읽는 중, null: 없음 — 카드 내용이 🔒) */
  keys: ContentKeys | null | undefined;
  /** 카드를 읽기 시작해도 되는가 (로그인 전이면 false). 기본 true */
  enabled?: boolean;
  /** 새로 만들거나 고칠 수 없는 상태 (목표) */
  readonly?: boolean;
  /** 머리 아래 안내 줄 */
  banners?: ReactNode;
  /** 🔒 안내. showWhenNoKeys: 키가 없을 때 보이는가 (기본 true), hint: 뒤에 붙는 설명 (기본: bitl pair 안내) */
  lockedNotice?: { showWhenNoKeys?: boolean; hint?: ReactNode };
  /** 카드 열 위 (처음 쓰는 사람 안내 등) */
  top?: (sessions: Session[]) => ReactNode;
  /** ☰ 메뉴: items 는 언어 앞, footer 는 언어 뒤. close() 로 메뉴를 닫는다. dot: 메뉴 단추에 점 */
  menu?: { items?: (close: () => void) => ReactNode; footer?: (close: () => void) => ReactNode; dot?: boolean };
  /** 보드 위에 여는 창 */
  overlays?: ReactNode;
}

/** ☰ 메뉴 항목 모양 (button·a 공통) */
export const MENU_ITEM = 'flex w-full items-center gap-3 px-4 py-3 text-left text-sm text-zinc-700 active:bg-zinc-100 dark:text-zinc-200 dark:active:bg-zinc-800';
export const MENU_ICON = 'size-[18px] text-zinc-500 dark:text-zinc-400';

export function Board({ keys, enabled = true, readonly = false, banners, lockedNotice, top, menu, overlays }: BoardProps) {
  const { sessions, approvals, goals, connection } = useSessions(enabled ? keys : undefined);
  // 목표: 고르면 그 목표의 카드만 보인다. 창: 새로 만들기(preselect: 처음부터 넣을 카드) 또는 편집
  const [goalId, setGoalId] = useState<string | null>(null);
  const [goalDialog, setGoalDialog] = useState<{ goal?: Goal; preselect?: string[] } | null>(null);
  const activeGoal = goalId ? goals.find((g) => g.id === goalId) : undefined;
  // 원격 승인: 카드마다 가장 오래 기다린 요청 하나
  const approvalFor = useMemo(() => {
    const map = new Map<string, Approval>();
    for (const a of [...approvals].sort((x, y) => x.createdAt.localeCompare(y.createdAt))) if (!map.has(a.sessionKey)) map.set(a.sessionKey, a);
    return map;
  }, [approvals]);
  // 보드에 카드가 없는 요청 (카드가 아직 안 왔거나 보관·종료로 숨김) — 놓치지 않게 위에 따로
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
    // 목표로 거르면 그 목표의 카드만. 종료된 카드는 열이 아니라 아래 "종료" 구역에
    const members = activeGoal ? new Set(activeGoal.members) : null;
    for (const s of sessions) {
      if (s.archived || s.status === 'ended' || (members && !members.has(s.key))) continue;
      map[columnOf(s.status)].push(s);
    }
    for (const col of COLUMNS) map[col.id].sort(sortFor(col.id));
    return map;
  }, [sessions, activeGoal]);
  const ended = useMemo(() => {
    const members = activeGoal ? new Set(activeGoal.members) : null;
    return sessions
      .filter((s) => !s.archived && s.status === 'ended' && (!members || members.has(s.key)))
      .sort((a, b) => (b.endedAt ?? b.statusAt).localeCompare(a.endedAt ?? a.statusAt));
  }, [sessions, activeGoal]);
  // 목표로 걸러 보는 중에도 "나를 기다림" 수(제목·배지·알림)는 전체 기준
  const attentionAll = useMemo(() => sessions.filter((s) => !s.archived && columnOf(s.status) === 'attention').length, [sessions]);
  // 고른 목표가 마쳐지거나 지워지면 거르기를 푼다
  useEffect(() => {
    if (goalId && !activeGoal) setGoalId(null);
  }, [goalId, activeGoal, goals]);

  const selected = selectedKey ? sessions.find((s) => s.key === selectedKey) : undefined;
  const attention = attentionAll;
  useOpenFromNotification(select);
  const lockedCount = useMemo(() => sessions.filter((s) => s.locked).length, [sessions]);
  // 목표 만들기·고치기: 키가 있고 읽기 전용이 아닐 때
  const canEdit = Boolean(keys) && !readonly;
  const showLocked = (keys === null && lockedNotice?.showWhenNoKeys !== false) || lockedCount > 0;

  useEffect(() => {
    document.title = attention ? `(${attention}) BITL` : 'BITL';
    setAppBadge(attention);
  }, [attention]);

  return (
    // side 패널이 열리면 보드가 패널 폭만큼 비켜서 계속 보인다
    <div className={`px-4 pb-10 sm:px-6 ${selected && mode === 'side' ? SIDE_PANEL_GUTTER : 'mx-auto max-w-[1600px]'}`}>
      <header className="sticky top-0 z-10 -mx-4 mb-4 flex flex-wrap items-center gap-3 border-b border-zinc-200 bg-zinc-50/90 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur sm:-mx-6 sm:px-6 dark:border-zinc-800 dark:bg-[#0b0d12]/90">
        <h1 className="text-lg font-bold tracking-tight">
          <a href="/" className="flex items-center gap-2">
            <Logo size={24} />
            BITL <BetaBadge /> <span className="hidden font-normal text-zinc-500 md:inline">· Being In The Loop</span>
          </a>
        </h1>
        {attention > 0 && (
          <span className="whitespace-nowrap rounded-full bg-red-500 px-2.5 py-0.5 text-sm font-semibold text-white">
            <span className="sm:hidden">{t('app.waitingShort', { n: attention })}</span>
            <span className="hidden sm:inline">{t('app.waitingLong', { n: attention })}</span>
          </span>
        )}
        {/* 한 줄에 꼭 필요한 것만 (연결 문제·목표), 나머지는 ☰ 메뉴로 — PC·휴대폰 같은 모양. 원격 승인 켜짐도 메뉴 안에 표시 */}
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

      {/* 열 수는 화면이 아니라 보드 폭 기준(container query) — 패널이 열려 좁아져도 자연스럽게 줄어든다 */}
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

/** 머리의 ☰ 메뉴 (PC·휴대폰 공통): 끼운 항목들과 언어 */
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
