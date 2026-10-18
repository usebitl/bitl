import type { Session } from '@bitl/shared/client';
import { useEffect, useMemo, useState } from 'react';
import { type Entry, ENTRY_KINDS, type EntryKind } from './entries';
import { EntryComposer, EntryList, kindLabel, useEntries } from './EntryViews';
import type { Goal } from './goals';
import { t } from './i18n';

/**
 * Looking back: a goal's notes (written on the goal or on its cards) and the journal (every note, by day).
 * Notes outlive cards, so a note from a removed card still shows where it was written.
 */

/** The goal's notes and a count by kind. Replaces the goal's card columns while "Notes" is chosen */
export function GoalJournal({ goal, sessions, now, canEdit }: { goal: Goal; sessions: Session[]; now: number; canEdit: boolean }) {
  const members = useMemo(() => new Set(goal.members), [goal.members]);
  const keep = (e: Entry) => e.goalId === goal.id || (e.sessionKey !== undefined && members.has(e.sessionKey));
  const { entries, more, loadMore } = useEntries({}, keep);
  const sessionKeys = useMemo(() => new Set(sessions.map((s) => s.key)), [sessions]);
  const counts = (k: EntryKind) => entries.filter((e) => e.kind === k).length;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <div className="min-w-0 space-y-4">
        <EntryComposer goalId={goal.id} canEdit={canEdit} placeholder={t('entry.placeholderGoal')} compact />
        <EntryList entries={entries} now={now} canEdit={canEdit} showWhere sessionKeys={sessionKeys} empty={t('entry.emptyGoal')} />
        {more && <MoreButton onClick={loadMore} />}
      </div>
      <aside className="h-fit rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <h3 className="text-sm font-semibold">{t('entry.goalSummary')}</h3>
        <dl className="mt-3 space-y-1.5 text-sm">
          {ENTRY_KINDS.map((k) => (
            <div key={k} className="flex justify-between">
              <dt className="text-zinc-600 dark:text-zinc-300">{kindLabel(k)}</dt>
              <dd className="font-semibold tabular-nums">{counts(k)}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs leading-relaxed text-zinc-500">{t('entry.goalHint')}</p>
      </aside>
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

const NO_KIND = 'none';
type KindFilter = EntryKind | typeof NO_KIND;

/** The journal: every note by day, with search and filters by kind and goal. Opened from the ☰ menu; covers the board */
export function Journal({ goals, sessions, now, canEdit, onClose }: { goals: Goal[]; sessions: Session[]; now: number; canEdit: boolean; onClose: () => void }) {
  const { entries, more, loadMore } = useEntries({});
  const [kinds, setKinds] = useState<Set<KindFilter>>(new Set([...ENTRY_KINDS, NO_KIND]));
  const [goalId, setGoalId] = useState('');
  const [linkGoal, setLinkGoal] = useState('');
  const [query, setQuery] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const sessionKeys = useMemo(() => new Set(sessions.map((s) => s.key)), [sessions]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const goal = goals.find((g) => g.id === goalId);
  const shown = entries.filter((e) => {
    if (!kinds.has(e.kind ?? NO_KIND)) return false;
    if (goal && e.goalId !== goal.id && !(e.sessionKey && goal.members.includes(e.sessionKey))) return false;
    const q = query.trim().toLowerCase();
    return !q || e.text.toLowerCase().includes(q) || (e.where?.title ?? '').toLowerCase().includes(q) || (e.where?.project ?? '').toLowerCase().includes(q);
  });
  const month = new Date(now);
  const thisMonth = entries.filter((e) => {
    const d = new Date(e.createdAt);
    return d.getFullYear() === month.getFullYear() && d.getMonth() === month.getMonth();
  }).length;
  const toggleKind = (k: KindFilter) =>
    setKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const select = 'h-10 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900';
  const filters = (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <label htmlFor="journal-search" className="text-xs text-zinc-500">
          {t('journal.search')}
        </label>
        <input id="journal-search" value={query} onChange={(e) => setQuery(e.target.value)} className={`${select} w-full px-3`} />
      </div>
      <fieldset className="space-y-2">
        <legend className="mb-1.5 text-xs text-zinc-500">{t('journal.kinds')}</legend>
        {([...ENTRY_KINDS, NO_KIND] as KindFilter[]).map((k) => (
          <label key={k} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={kinds.has(k)} onChange={() => toggleKind(k)} />
            {kindLabel(k === NO_KIND ? undefined : k)}
            <span className="text-zinc-400 tabular-nums">{entries.filter((e) => (e.kind ?? NO_KIND) === k).length}</span>
          </label>
        ))}
      </fieldset>
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
    <div className="fixed inset-0 z-40 overflow-y-auto bg-zinc-50 dark:bg-[#0b0d12]" role="dialog" aria-modal="true" aria-labelledby="journal-title">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-zinc-200 bg-zinc-50/90 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur sm:px-6 dark:border-zinc-800 dark:bg-[#0b0d12]/90">
        <button type="button" onClick={onClose} className="flex h-10 items-center gap-1 rounded-lg px-2 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800">
          <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          {t('journal.back')}
        </button>
        <h1 id="journal-title" className="text-lg font-bold">
          {t('journal.title')}
        </h1>
        <button
          type="button"
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen((v) => !v)}
          className="ml-auto h-10 rounded-lg border border-zinc-300 px-3 text-sm lg:hidden dark:border-zinc-700"
        >
          {t('journal.filters')}
        </button>
      </header>
      <div className="mx-auto flex max-w-[1200px] gap-8 px-4 py-5 sm:px-6">
        <main className="min-w-0 flex-1 space-y-4 pb-72 lg:pb-8">
          {filtersOpen && <div className="rounded-xl border border-zinc-200 bg-white p-4 lg:hidden dark:border-zinc-800 dark:bg-zinc-900">{filters}</div>}
          {/* On a phone the composer sits at the bottom, within thumb reach */}
          <div className="fixed inset-x-0 bottom-0 z-10 border-t border-zinc-200 bg-zinc-50 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:static lg:border-0 lg:bg-transparent lg:p-0 dark:border-zinc-800 dark:bg-[#0b0d12] lg:dark:bg-transparent">
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
            <EntryComposer goalId={linkGoal || undefined} canEdit={canEdit} placeholder={t('journal.placeholder')} compact />
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
          <div className="sticky top-24">{filters}</div>
        </aside>
      </div>
    </div>
  );
}
