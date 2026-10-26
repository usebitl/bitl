import type { Session } from '@bitl/shared/client';
import { useEffect, useMemo, useState } from 'react';
import type { Entry } from './entries';
import { EntryComposer, EntryList, useEntries } from './EntryViews';
import type { Goal } from './goals';
import { getLang, t } from './i18n';

/**
 * Looking back: a goal's notes (written on the goal or on its cards) and the journal (every note, by day).
 * Notes outlive cards, so a note from a removed card still shows where it was written.
 */

/** The goal's notes and how they piled up over time. Replaces the goal's card columns while "Notes" is chosen */
export function GoalJournal({ goal, sessions, now, canEdit }: { goal: Goal; sessions: Session[]; now: number; canEdit: boolean }) {
  const members = useMemo(() => new Set(goal.members), [goal.members]);
  const keep = (e: Entry) => e.goalId === goal.id || (e.sessionKey !== undefined && members.has(e.sessionKey));
  const { entries, more, loadMore } = useEntries({}, keep);
  const sessionKeys = useMemo(() => new Set(sessions.map((s) => s.key)), [sessions]);
  const days = new Set(entries.map((e) => localDay(new Date(e.createdAt)))).size;
  const first = entries.at(-1);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <div className="min-w-0 space-y-4">
        <EntryComposer goalId={goal.id} canEdit={canEdit} placeholder={t('entry.placeholderGoal')} />
        <EntryList entries={entries} now={now} canEdit={canEdit} showWhere sessionKeys={sessionKeys} empty={t('entry.emptyGoal')} />
        {more && <MoreButton onClick={loadMore} />}
      </div>
      <aside className="h-fit rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <h3 className="text-sm font-semibold">{t('entry.goalSummary')}</h3>
        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
          <Stat label={t('entry.statCount')} value={String(entries.length)} />
          <Stat label={t('entry.statDays')} value={String(days)} />
          {first && <Stat label={t('entry.statFirst')} value={new Intl.DateTimeFormat(getLang(), { month: 'numeric', day: 'numeric' }).format(new Date(first.createdAt))} />}
        </dl>
        <RecentDays entries={entries} now={now} />
        <p className="mt-3 text-xs leading-relaxed text-zinc-500">{t('entry.goalHint')}</p>
      </aside>
    </div>
  );
}

const localDay = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col-reverse">
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

const RECENT_DAYS = 14;

/** A bar per day for the last two weeks, taller with more notes; empty days stay a faint stub */
function RecentDays({ entries, now }: { entries: Entry[]; now: number }) {
  const counts = new Map<string, number>();
  for (const e of entries) {
    const key = localDay(new Date(e.createdAt));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const today = new Date(now);
  const bars = Array.from({ length: RECENT_DAYS }, (_, i) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (RECENT_DAYS - 1 - i));
    return { date: d, n: counts.get(localDay(d)) ?? 0 };
  });
  const max = Math.max(1, ...bars.map((b) => b.n));
  const fmt = new Intl.DateTimeFormat(getLang(), { month: 'numeric', day: 'numeric' });
  const active = bars.filter((b) => b.n > 0).length;
  return (
    <div className="mt-4">
      <p className="mb-1.5 text-xs text-zinc-500">{t('entry.recentDays', { n: active })}</p>
      <div className="flex h-8 items-end gap-[3px]" role="img" aria-label={t('entry.recentDays', { n: active })}>
        {bars.map((b) => (
          <span
            key={b.date.toISOString()}
            title={`${fmt.format(b.date)} · ${b.n}`}
            style={{ height: b.n ? `${30 + (70 * b.n) / max}%` : '15%' }}
            className={`flex-1 rounded-sm ${b.n ? 'bg-zinc-500 dark:bg-zinc-400' : 'bg-zinc-200 dark:bg-zinc-800'}`}
          />
        ))}
      </div>
    </div>
  );
}

function MoreButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="w-full rounded-lg border border-zinc-300 py-2 text-sm text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900">
      {t('journal.more')}
    </button>
  );
}

/** The journal: every note by day, with search and a filter by goal. Opened from the ☰ menu; covers the board */
export function Journal({ goals, sessions, now, canEdit, onClose }: { goals: Goal[]; sessions: Session[]; now: number; canEdit: boolean; onClose: () => void }) {
  const { entries, more, loadMore } = useEntries({});
  const [goalId, setGoalId] = useState('');
  const [linkGoal, setLinkGoal] = useState('');
  const [query, setQuery] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const sessionKeys = useMemo(() => new Set(sessions.map((s) => s.key)), [sessions]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    // Keep the board behind from scrolling along
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  const goal = goals.find((g) => g.id === goalId);
  const shown = entries.filter((e) => {
    if (goal && e.goalId !== goal.id && !(e.sessionKey && goal.members.includes(e.sessionKey))) return false;
    const q = query.trim().toLowerCase();
    return !q || e.text.toLowerCase().includes(q) || (e.where?.title ?? '').toLowerCase().includes(q) || (e.where?.project ?? '').toLowerCase().includes(q);
  });
  const month = new Date(now);
  const thisMonth = entries.filter((e) => {
    const d = new Date(e.createdAt);
    return d.getFullYear() === month.getFullYear() && d.getMonth() === month.getMonth();
  }).length;

  const select = 'h-10 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900';
  const filters = (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <label htmlFor="journal-search" className="text-xs text-zinc-500">
          {t('journal.search')}
        </label>
        <input id="journal-search" value={query} onChange={(e) => setQuery(e.target.value)} className={`${select} w-full px-3`} />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="journal-goal" className="text-xs text-zinc-500">
          {t('journal.goal')}
        </label>
        <select id="journal-goal" value={goalId} onChange={(e) => setGoalId(e.target.value)} className={`${select} w-full`}>
          <option value="">{t('journal.allGoals')}</option>
          {goals.map((g) => (
            <option key={g.id} value={g.id}>
              {g.title}
            </option>
          ))}
        </select>
      </div>
      <p className="border-t border-zinc-200 pt-4 text-sm text-zinc-500 dark:border-zinc-800">{t('journal.thisMonth', { n: thisMonth })}</p>
    </div>
  );

  return (
    // Same frame as the focus view: an opaque layer over the whole window (themes make the page color translucent), closed at the top right
    <div className="fixed inset-0 z-50 flex flex-col bg-white dark:bg-zinc-950" role="dialog" aria-modal="true" aria-labelledby="journal-title">
      <header className="flex items-center gap-3 border-b border-zinc-200 px-5 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] dark:border-zinc-800">
        <h1 id="journal-title" className="min-w-0 flex-1 truncate font-semibold">
          {t('journal.title')}
        </h1>
        <button
          type="button"
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen((v) => !v)}
          className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm lg:hidden dark:border-zinc-700"
        >
          {t('journal.filters')}
        </button>
        <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-100">
          {t('detail.focusClose')}
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[1200px] gap-8 px-4 py-5 sm:px-6">
        <main className="min-w-0 flex-1 space-y-4 pb-72 lg:pb-8">
          {filtersOpen && <div className="rounded-xl border border-zinc-200 bg-white p-4 lg:hidden dark:border-zinc-800 dark:bg-zinc-900">{filters}</div>}
          {/* On a phone the composer sits at the bottom, within thumb reach */}
          <div className="fixed inset-x-0 bottom-0 z-10 border-t border-zinc-200 bg-white p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:static lg:border-0 lg:bg-transparent lg:p-0 dark:border-zinc-800 dark:bg-zinc-950 lg:dark:bg-transparent">
            {goals.length > 0 && (
              <div className="mb-2 flex items-center gap-2">
                <label htmlFor="journal-link-goal" className="text-xs text-zinc-500">
                  {t('journal.linkGoal')}
                </label>
                <select id="journal-link-goal" value={linkGoal} onChange={(e) => setLinkGoal(e.target.value)} className={select}>
                  <option value="">{t('journal.none')}</option>
                  {goals.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.title}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <EntryComposer goalId={linkGoal || undefined} canEdit={canEdit} placeholder={t('journal.placeholder')} />
          </div>
          <EntryList
            entries={shown}
            now={now}
            canEdit={canEdit}
            showWhere
            goals={goals}
            sessionKeys={sessionKeys}
            empty={entries.length === 0 ? t('journal.empty') : t('journal.noMatch')}
          />
          {more && <MoreButton onClick={loadMore} />}
        </main>
        <aside className="hidden w-64 shrink-0 lg:block">
          <div className="sticky top-5">{filters}</div>
        </aside>
      </div>
      </div>
    </div>
  );
}
