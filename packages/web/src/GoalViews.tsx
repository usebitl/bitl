import { type BoardColumn, columnOf, displayTitle, type Session } from '@bitl/shared/client';
import { type FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { changeGoal, createGoal, deleteGoal, type Goal, setGoalClosed, toggleMember } from './goals';
import { SOURCE_LABEL } from './format';
import { GoalAddIcon } from './Icons';
import { rich, t, titleLabels } from './i18n';

/**
 * Goal UI pieces: the goal bar (GoalsBar) and its full list (GoalList), the filtering notice (GoalFilter), the create/edit dialog (GoalDialog), and the card's goal menu (CardGoalMenu).
 * A goal's counts and bar reflect the current state of its linked cards (deleted, archived or cleared cards are not counted).
 */

/** + icon — the '+' character sits at different heights per font and misaligns vertically with adjacent text */
export function PlusIcon({ className = 'size-3.5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={`shrink-0 ${className}`} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

const COLS: BoardColumn[] = ['attention', 'running', 'review', 'rest'];
const BAR: Record<BoardColumn, string> = { attention: 'bg-red-500', running: 'bg-emerald-500', review: 'bg-amber-400', rest: 'bg-zinc-400 dark:bg-zinc-600' };

/** The goal's linked cards that are on the board */
export function goalSessions(goal: Goal, sessions: Session[]): Session[] {
  const keys = new Set(goal.members);
  return sessions.filter((s) => keys.has(s.key) && !s.archived && !s.cleared && !s.replacedBy);
}

/**
 * A card continued in a new session (`--resume` that started one) leaves the board; the card that continues it joins
 * the goals the earlier card was in. Goal content is sealed in the browser, so this browser adds it (once per goal and card)
 */
export function useGoalsFollowResume(goals: Goal[], sessions: Session[], canEdit: boolean) {
  const tried = useRef(new Set<string>());
  useEffect(() => {
    if (!canEdit) return;
    for (const g of goals) {
      if (g.locked || g.closedAt) continue;
      const members = new Set(g.members);
      for (const s of sessions) {
        const id = `${g.id}\n${s.key}`;
        if (members.has(s.key) || tried.current.has(id) || !s.resumedFrom?.some((k) => members.has(k))) continue;
        tried.current.add(id);
        void changeGoal(g, (c) => (c.members.includes(s.key) ? c : { ...c, members: [...c.members, s.key] })).catch(() => {});
      }
    }
  }, [goals, sessions, canEdit]);
}

function countBy(list: Session[]): Record<BoardColumn, number> {
  const c: Record<BoardColumn, number> = { attention: 0, running: 0, review: 0, rest: 0 };
  for (const s of list) c[columnOf(s.status)] += 1;
  return c;
}

/** How urgently a goal wants a look: someone waiting first, then results to check, then work in progress, then nothing going on */
const URGENCY: BoardColumn[] = ['attention', 'review', 'running', 'rest'];
const tierOf = (c: Record<BoardColumn, number>): BoardColumn => URGENCY.find((col) => col !== 'rest' && c[col] > 0) ?? 'rest';
const DOT: Record<BoardColumn, string> = { attention: 'bg-red-500', running: 'bg-emerald-500', review: 'bg-amber-400', rest: 'bg-zinc-400' };

interface GoalRow {
  goal: Goal;
  c: Record<BoardColumn, number>;
  total: number;
  tier: BoardColumn;
}

const goalTitle = (g: Goal) => (g.locked ? t('goal.locked') : g.title);
const statusText = (r: GoalRow) => COLS.filter((col) => r.c[col] > 0).map((col) => t(`goal.s.${col}`, { n: r.c[col] })).join(' · ');

/** shrink: in the row the chip may narrow (title cut short) when even one doesn't fit, as on a phone */
function GoalChip({ row, on, onClick, shrink = false }: { row: GoalRow; on: boolean; onClick: () => void; shrink?: boolean }) {
  const { goal, c, total, tier } = row;
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      title={[goalTitle(goal), statusText(row)].filter(Boolean).join(' — ')}
      className={`inline-flex h-8 ${shrink ? 'min-w-0' : 'shrink-0'} items-center gap-2 rounded-full border bg-white px-3 text-sm dark:bg-zinc-900 ${
        on
          ? 'border-sky-500 bg-sky-50 ring-1 ring-sky-500 dark:bg-sky-500/10'
          : c.attention
            ? 'border-red-300 hover:border-red-400 dark:border-red-500/50'
            : 'border-zinc-200 hover:border-sky-300 dark:border-zinc-800 dark:hover:border-sky-700'
      } ${tier === 'rest' && !on ? 'text-zinc-500 dark:text-zinc-400' : ''}`}
    >
      <span className={`size-2 shrink-0 rounded-full ${DOT[tier]}`} />
      <span className="min-w-0 max-w-[14rem] truncate font-medium">{goalTitle(goal)}</span>
      <span className="flex h-1 w-8 shrink-0 overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800">
        {total > 0 && COLS.map((col) => c[col] > 0 && <i key={col} className={BAR[col]} style={{ width: `${(c[col] / total) * 100}%` }} />)}
      </span>
      <span className={`shrink-0 text-xs tabular-nums ${c.attention ? 'font-semibold text-red-600 dark:text-red-400' : 'text-zinc-500'}`}>
        {c.attention ? `!${c.attention}` : total}
      </span>
    </button>
  );
}

/**
 * The goals as one row of chips, most urgent first, so what needs a look is always in view however many goals there are.
 * Whatever doesn't fit folds into "+n", which opens the full list (search, grouped by urgency, finish for goals with nothing going on)
 */
export function GoalsBar({
  goals,
  sessions,
  selected,
  onSelect,
  onCreate,
}: {
  goals: Goal[];
  sessions: Session[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  onCreate: () => void;
}) {
  // Most urgent first; within a tier, the order they were made in, so chips don't shuffle on every count change
  const rows = useMemo<GoalRow[]>(() => {
    const list = goals.map((goal) => {
      const members = goalSessions(goal, sessions);
      const c = countBy(members);
      return { goal, c, total: members.length, tier: tierOf(c) };
    });
    return list.sort((a, b) => URGENCY.indexOf(a.tier) - URGENCY.indexOf(b.tier));
  }, [goals, sessions]);

  // How many chips fit in one row: measured from an invisible copy of every chip, then again whenever the row resizes
  const rowRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(rows.length);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const row = rowRef.current;
    const measure = measureRef.current;
    if (!row || !measure) return;
    const compute = () => {
      const widths = [...measure.children].map((el) => (el as HTMLElement).offsetWidth);
      const GAP = 8;
      const tail = 40 + GAP; // the create button
      const moreW = 90 + GAP; // the "+n" chip
      let used = 0;
      let n = 0;
      for (const w of widths) {
        const rest = n + 1 < widths.length ? moreW : 0;
        if (used + w + tail + rest > row.clientWidth - 8) break; // less the row's side padding
        used += w + GAP;
        n += 1;
      }
      setFit(Math.max(1, n));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(row);
    return () => ro.disconnect();
  }, [rows]);

  if (goals.length === 0) return null;
  // The chosen goal always stays in view: it takes the last visible slot if it would have been folded away
  let shown = rows.slice(0, fit);
  const chosen = rows.find((r) => r.goal.id === selected);
  if (chosen && !shown.includes(chosen)) shown = [...shown.slice(0, Math.max(0, fit - 1)), chosen];
  const hidden = rows.length - shown.length;

  return (
    <div className="relative mb-3">
      <div ref={rowRef} role="group" aria-label={t('goal.bar')} className="-mx-1 flex items-center gap-2 overflow-hidden px-1 py-0.5">
        {shown.map((r) => (
          <GoalChip key={r.goal.id} row={r} shrink on={selected === r.goal.id} onClick={() => onSelect(selected === r.goal.id ? null : r.goal.id)} />
        ))}
        {hidden > 0 && (
          <button
            type="button"
            data-goal-more
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="inline-flex h-8 shrink-0 items-center rounded-full border border-dashed border-zinc-300 px-3 text-sm tabular-nums text-zinc-600 hover:bg-white dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
          >
            {t('goal.more', { n: hidden })}
          </button>
        )}
        <button
          type="button"
          onClick={onCreate}
          title={t('goal.addLong')}
          aria-label={t('goal.addLong')}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-dashed border-zinc-300 text-zinc-500 hover:bg-white hover:text-zinc-800 dark:border-zinc-700 dark:hover:bg-zinc-900 dark:hover:text-zinc-200"
        >
          <GoalAddIcon className="size-[18px]" />
        </button>
      </div>
      {/* Every chip laid out unseen, only to measure widths — clipped so it can't widen the page */}
      <div aria-hidden="true" className="pointer-events-none invisible absolute inset-x-0 top-0 h-0 overflow-hidden">
        <div ref={measureRef} className="flex w-max gap-2">
          {rows.map((r) => (
            <GoalChip key={r.goal.id} row={r} on={false} onClick={() => {}} />
          ))}
        </div>
      </div>
      {open && (
        <GoalList
          rows={rows}
          selected={selected}
          onPick={(id) => {
            onSelect(id);
            setOpen(false);
          }}
          onFinished={(id) => id === selected && onSelect(null)}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

/** Every goal, grouped by urgency, with a search. Goals with no card going on sit last, with a button to finish them */
function GoalList({
  rows,
  selected,
  onPick,
  onFinished,
  onClose,
}: {
  rows: GoalRow[];
  selected: string | null;
  onPick: (id: string) => void;
  onFinished: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [finishing, setFinishing] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onPress = (e: PointerEvent) => {
      // The "+n" chip toggles the list itself
      const target = e.target as HTMLElement;
      if (!root.current?.contains(target) && !target.closest('[data-goal-more]')) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('pointerdown', onPress);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPress);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const q = query.trim().toLowerCase();
  const found = rows.filter((r) => !q || goalTitle(r.goal).toLowerCase().includes(q));
  const finish = async (goal: Goal) => {
    setFinishing(goal.id);
    try {
      await setGoalClosed(goal, true);
      onFinished(goal.id);
    } finally {
      setFinishing(null);
    }
  };

  return (
    <div
      ref={root}
      className="absolute right-0 top-full z-30 mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-zinc-200 bg-white p-2 shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
    >
      <label htmlFor="goal-search" className="sr-only">
        {t('goal.search')}
      </label>
      <input
        id="goal-search"
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('goal.search')}
        className="h-9 w-full rounded-lg border border-zinc-300 bg-zinc-50 px-3 text-base outline-none focus:border-zinc-500 sm:text-sm dark:border-zinc-700 dark:bg-zinc-950"
      />
      <div className="mt-1 max-h-[60vh] overflow-y-auto">
        {found.length === 0 && <p className="px-2 py-3 text-sm text-zinc-400">{t('goal.noMatch')}</p>}
        {URGENCY.map((tier) => {
          const list = found.filter((r) => r.tier === tier);
          if (list.length === 0) return null;
          return (
            <section key={tier}>
              <h4 className="px-2 pb-1 pt-2.5 text-xs font-medium text-zinc-500">{tier === 'rest' ? t('goal.g.idle') : t(`app.col.${tier}`)}</h4>
              <ul>
                {list.map((r) => (
                  <li key={r.goal.id} className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => onPick(r.goal.id)}
                      className={`flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
                        selected === r.goal.id ? 'bg-sky-50 dark:bg-sky-500/10' : ''
                      } ${tier === 'rest' ? 'text-zinc-500 dark:text-zinc-400' : ''}`}
                    >
                      <span className={`size-2 shrink-0 rounded-full ${DOT[r.tier]}`} />
                      <span className="min-w-0 flex-1 truncate">{goalTitle(r.goal)}</span>
                      <span className="shrink-0 text-xs tabular-nums text-zinc-400">{tier === 'rest' ? t('goal.cards', { n: r.total }) : statusText(r)}</span>
                    </button>
                    {tier === 'rest' && !r.goal.locked && (
                      <button
                        type="button"
                        disabled={finishing === r.goal.id}
                        onClick={() => void finish(r.goal)}
                        className="shrink-0 rounded-md border border-zinc-300 px-2 py-0.5 text-xs text-zinc-600 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                      >
                        {t('goal.finishShort')}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

/** Filtering by a goal: what you are viewing, plus edit / finish / show all */
/** view: the goal's cards, or the notes left on it and on its cards */
export type GoalView = 'cards' | 'entries';

export function GoalFilter({
  goal,
  count,
  view,
  onView,
  onEdit,
  onClear,
}: {
  goal: Goal;
  count: number;
  view: GoalView;
  onView: (v: GoalView) => void;
  onEdit: () => void;
  onClear: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const finish = async () => {
    setBusy(true);
    try {
      await setGoalClosed(goal, true);
      onClear();
    } finally {
      setBusy(false);
    }
  };
  const btn = 'rounded-lg border border-zinc-300 bg-white px-2.5 py-1 text-sm hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800';
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-sky-300 bg-sky-50 px-3 py-2 text-sm dark:border-sky-500/40 dark:bg-sky-500/10">
      <span>
        ◎ {rich('goal.filtering', { b: (s) => <b className="text-sky-700 dark:text-sky-300">{s}</b> }, { title: goal.title, n: count })}
      </span>
      <span className="ml-auto flex flex-wrap gap-2">
        <span className="flex rounded-lg border border-zinc-300 bg-white p-0.5 dark:border-zinc-700 dark:bg-zinc-900" role="group" aria-label={t('goal.view')}>
          {(['cards', 'entries'] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => onView(v)}
              className={`rounded-md px-2.5 py-0.5 text-sm ${view === v ? 'bg-zinc-900 font-semibold text-white dark:bg-zinc-100 dark:text-zinc-900' : 'text-zinc-600 dark:text-zinc-300'}`}
            >
              {v === 'cards' ? t('goal.view.cards') : t('goal.view.entries')}
            </button>
          ))}
        </span>
        <button type="button" className={btn} onClick={onEdit}>
          {t('goal.edit')}
        </button>
        <button type="button" className={btn} onClick={finish} disabled={busy}>
          {t('goal.finish')}
        </button>
        <button type="button" className={btn} onClick={onClear}>
          {t('goal.showAll')}
        </button>
      </span>
    </div>
  );
}

/** Groups cards by project@branch — makes it easy to pick cards from the same line of work at once */
function groupByWhere(sessions: Session[]): [string, Session[]][] {
  const groups = new Map<string, Session[]>();
  for (const s of sessions) {
    const where = s.project ? `${s.project}${s.gitBranch ? `@${s.gitBranch}` : ''}` : '';
    groups.set(where, [...(groups.get(where) ?? []), s]);
  }
  // groups with multiple cards first, unnamed group last
  return [...groups.entries()].sort(([a, x], [b, y]) => (a === '' ? 1 : b === '' ? -1 : y.length - x.length || a.localeCompare(b)));
}

/** Create or edit a goal. Edit when goal is given */
export function GoalDialog({
  goal,
  sessions,
  preselect = [],
  onClose,
  onDeleted,
}: {
  goal?: Goal;
  sessions: Session[];
  preselect?: string[];
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const [title, setTitle] = useState(goal?.title ?? '');
  const [picked, setPicked] = useState<Set<string>>(() => new Set(goal?.members ?? preselect));
  const [state, setState] = useState<'idle' | 'busy' | 'error'>('idle');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Cards on the board (not archived or cleared), most recent activity first. Currently linked cards are shown even if ended
  const candidates = useMemo(
    () =>
      sessions
        .filter((s) => !s.archived && ((!s.cleared && s.status !== 'ended') || picked.has(s.key)))
        .sort((a, b) => b.lastEventAt.localeCompare(a.lastEventAt)),
    // depending on picked would reshuffle the list on every check — use the state when first opened
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessions],
  );
  const groups = useMemo(() => groupByWhere(candidates), [candidates]);
  const count = candidates.filter((s) => picked.has(s.key)).length;

  const toggle = (keys: string[], on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      for (const k of keys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setState('busy');
    try {
      // Edit: cards gone from the board (deleted) are pruned from the list — keep only cards on screen
      const members = candidates.filter((s) => picked.has(s.key)).map((s) => s.key);
      if (goal) await changeGoal(goal, () => ({ title: title.trim(), members }));
      else await createGoal({ title: title.trim(), members });
      onClose();
    } catch {
      setState('error');
    }
  };

  const remove = async () => {
    if (!goal) return;
    setState('busy');
    await deleteGoal(goal).catch(() => {});
    onDeleted?.();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/45 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-labelledby="goal-dialog-title"
        className="max-h-[calc(100dvh-2rem)] w-full max-w-xl overflow-auto rounded-2xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
      >
        <h2 id="goal-dialog-title" className="text-lg font-bold">
          {goal ? t('goal.edit.title') : t('goal.new.title')}
        </h2>
        <p className="mt-1 text-sm text-zinc-500">{t('goal.dialog.sub')}</p>

        <label htmlFor="goal-title" className="mt-4 block text-sm font-semibold">
          {t('goal.name')}
        </label>
        <input
          ref={input}
          id="goal-title"
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('goal.namePlaceholder')}
          className="mt-1.5 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-base outline-none focus:border-sky-500 sm:text-sm dark:border-zinc-700 dark:bg-zinc-950"
        />

        <p className="mt-4 text-sm font-semibold">
          {t('goal.pick')} <span className="font-normal text-zinc-500">{t('goal.pickLater')}</span>
        </p>
        {candidates.length === 0 ? (
          <p className="mt-2 rounded-lg border border-dashed border-zinc-300 p-4 text-sm text-zinc-500 dark:border-zinc-700">{t('goal.noCards')}</p>
        ) : (
          <div className="mt-2 overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
            {groups.map(([where, list]) => {
              const all = list.every((s) => picked.has(s.key));
              return (
                <div key={where || '-'}>
                  <div className="flex items-center gap-2 bg-zinc-50 px-3 py-1.5 text-xs text-zinc-500 dark:bg-zinc-800/60">
                    <span className="min-w-0 flex-1 truncate font-mono">{where || t('goal.other')}</span>
                    {list.length > 1 && (
                      <button type="button" className="shrink-0 font-semibold text-sky-600 dark:text-sky-400" onClick={() => toggle(list.map((s) => s.key), !all)}>
                        {all ? t('goal.pickNone') : t('goal.pickAll')}
                      </button>
                    )}
                  </div>
                  {list.map((s) => (
                    <label key={s.key} className="flex cursor-pointer items-center gap-3 border-t border-zinc-100 px-3 py-2 dark:border-zinc-800">
                      <input type="checkbox" checked={picked.has(s.key)} onChange={(e) => toggle([s.key], e.target.checked)} className="size-4 accent-sky-600" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{displayTitle(s, titleLabels())}</span>
                        <span className="block truncate text-xs text-zinc-500">{SOURCE_LABEL[s.source]}</span>
                      </span>
                    </label>
                  ))}
                </div>
              );
            })}
          </div>
        )}

        {state === 'error' && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{t('goal.err')}</p>}

        {confirmDelete ? (
          <div className="mt-5 flex flex-wrap items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-500/10 dark:text-red-300">
            <span className="flex-1">{t('goal.deleteConfirm')}</span>
            <button type="button" className="rounded-lg border border-zinc-300 bg-white px-3 py-1 dark:border-zinc-700 dark:bg-zinc-900" onClick={() => setConfirmDelete(false)}>
              {t('goal.cancel')}
            </button>
            <button type="button" className="rounded-lg bg-red-600 px-3 py-1 font-medium text-white" onClick={remove} disabled={state === 'busy'}>
              {t('goal.deleteYes')}
            </button>
          </div>
        ) : (
          <div className="mt-5 flex flex-wrap items-center gap-2">
            {goal && (
              <button type="button" className="text-sm text-red-600 hover:underline dark:text-red-400" onClick={() => setConfirmDelete(true)}>
                {t('goal.delete')}
              </button>
            )}
            <span className="ml-auto flex gap-2">
              <button type="button" className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700" onClick={onClose}>
                {t('goal.cancel')}
              </button>
              <button
                type="submit"
                disabled={!title.trim() || state === 'busy'}
                className="rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
              >
                {goal ? t('goal.save', { n: count }) : t('goal.create', { n: count })}
              </button>
            </span>
          </div>
        )}
      </form>
    </div>
  );
}

/** The card's goal menu: add to / remove from each goal, or create a new goal with it */
export function CardGoalMenu({ sessionKey, goals, onNewGoal }: { sessionKey: string; goals: Goal[]; onNewGoal: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const inGoals = goals.filter((g) => g.members.includes(sessionKey));
  const toggle = async (g: Goal, on: boolean) => {
    setBusy(g.id);
    await toggleMember(g, sessionKey, on).catch(() => {});
    setBusy(null);
  };
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={t('goal.cardMenu')}
        aria-label={t('goal.cardMenu')}
        aria-expanded={open}
        className={`absolute right-8 top-3 rounded-md px-1.5 py-0.5 text-sm leading-5 hover:bg-zinc-100 focus:opacity-100 dark:hover:bg-zinc-800 ${
          inGoals.length ? 'text-sky-600 dark:text-sky-400' : 'text-zinc-400 sm:opacity-0 sm:group-hover:opacity-100'
        }`}
      >
        ◎
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div role="menu" className="absolute right-2 top-9 z-30 w-60 rounded-xl border border-zinc-200 bg-white p-1.5 text-sm shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
            <p className="px-2 pb-1 pt-1.5 text-xs text-zinc-500">{t('goal.cardMenu')}</p>
            {goals.length === 0 && <p className="px-2 py-1.5 text-zinc-500">{t('goal.none')}</p>}
            {goals.map((g) => (
              <label key={g.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800">
                <input
                  type="checkbox"
                  disabled={busy === g.id || g.locked}
                  checked={g.members.includes(sessionKey)}
                  onChange={(e) => toggle(g, e.target.checked)}
                  className="size-4 accent-sky-600"
                />
                <span className="min-w-0 flex-1 truncate">◎ {g.locked ? t('goal.locked') : g.title}</span>
              </label>
            ))}
            <div className="my-1 border-t border-zinc-100 dark:border-zinc-800" />
            <button
              type="button"
              className="w-full rounded-lg px-2 py-1.5 text-left text-sky-600 hover:bg-zinc-50 dark:text-sky-400 dark:hover:bg-zinc-800"
              onClick={() => {
                setOpen(false);
                onNewGoal();
              }}
            >
              {t('goal.newWith')}
            </button>
          </div>
        </>
      )}
    </>
  );
}

/** Goal name shown on a card */
export function GoalBadges({ sessionKey, goals }: { sessionKey: string; goals: Goal[] }) {
  const mine = goals.filter((g) => !g.locked && g.members.includes(sessionKey));
  if (mine.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {mine.map((g) => (
        <span key={g.id} className="max-w-full truncate rounded-full border border-sky-300 px-2 text-[0.7rem] text-sky-700 dark:border-sky-500/40 dark:text-sky-300">
          ◎ {g.title}
        </span>
      ))}
    </div>
  );
}
