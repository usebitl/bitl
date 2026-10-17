import { type BoardColumn, columnOf, displayTitle, type Session } from '@bitl/shared/client';
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { changeGoal, createGoal, deleteGoal, type Goal, setGoalClosed, toggleMember } from './goals';
import { SOURCE_LABEL } from './format';
import { rich, t, titleLabels } from './i18n';

/**
 * Goal UI pieces: the goal bar (GoalsBar), the filtering notice (GoalFilter), the create/edit dialog (GoalDialog), and the card's goal menu (CardGoalMenu).
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
  if (goals.length === 0) return null;
  return (
    <div role="group" aria-label={t('goal.bar')} className="-mx-1 mb-3 flex gap-2.5 overflow-x-auto px-1 pb-1">
      {goals.map((g) => {
        const members = goalSessions(g, sessions);
        const c = countBy(members);
        const total = members.length;
        const on = selected === g.id;
        const dot = c.attention ? 'bg-red-500' : c.running ? 'bg-emerald-500' : c.review ? 'bg-amber-400' : 'bg-zinc-400';
        return (
          <button
            key={g.id}
            type="button"
            aria-pressed={on}
            onClick={() => onSelect(on ? null : g.id)}
            className={`grid w-64 shrink-0 gap-1.5 rounded-xl border bg-white px-3 py-2.5 text-left dark:bg-zinc-900 ${
              on
                ? 'border-sky-500 ring-1 ring-sky-500'
                : c.attention
                  ? 'border-red-300 hover:border-red-400 dark:border-red-500/50'
                  : 'border-zinc-200 hover:border-sky-300 dark:border-zinc-800 dark:hover:border-sky-700'
            }`}
          >
            <span className="flex items-center gap-1.5">
              <span className={`size-2 shrink-0 rounded-full ${dot}`} />
              <span className="min-w-0 flex-1 truncate font-semibold">{g.locked ? t('goal.locked') : g.title}</span>
              <span className="shrink-0 text-xs tabular-nums text-zinc-500">{t('goal.cards', { n: total })}</span>
            </span>
            <span className="flex h-1.5 overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800">
              {total > 0 && COLS.map((col) => c[col] > 0 && <i key={col} className={BAR[col]} style={{ width: `${(c[col] / total) * 100}%` }} />)}
            </span>
            <span className="flex flex-wrap gap-x-2.5 text-xs tabular-nums text-zinc-500">
              {COLS.map((col) => c[col] > 0 && <span key={col}>{t(`goal.s.${col}`, { n: c[col] })}</span>)}
            </span>
          </button>
        );
      })}
      <button
        type="button"
        onClick={onCreate}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-dashed border-zinc-300 px-4 text-sm text-zinc-500 hover:bg-white dark:border-zinc-700 dark:hover:bg-zinc-900"
      >
        <PlusIcon />
        {t('goal.addLong')}
      </button>
    </div>
  );
}

/** Filtering by a goal: what you are viewing, plus edit / finish / show all */
export function GoalFilter({ goal, count, onEdit, onClear }: { goal: Goal; count: number; onEdit: () => void; onClear: () => void }) {
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
        className={`absolute right-8 top-2 rounded-md px-1.5 py-0.5 text-sm hover:bg-zinc-100 focus:opacity-100 dark:hover:bg-zinc-800 ${
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
