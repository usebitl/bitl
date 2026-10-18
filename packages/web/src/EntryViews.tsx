import { useCallback, useEffect, useRef, useState } from 'react';
import { deleteEntry, type Entry, ENTRY_KINDS, ENTRY_LIMIT, type EntryContent, type EntryKind, type EntryWhere, fetchEntries, onEntry, rewriteEntry, writeEntry } from './entries';
import type { Goal } from './goals';
import { getLang, t } from './i18n';

/**
 * Entry pieces shared by the card detail ("Notes" tab), the goal view and the journal:
 * the composer (kind + one or two lines), the list grouped by day, and the hook that loads entries and keeps them live.
 */

const KIND_STYLE: Record<EntryKind | 'none', string> = {
  solved: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  learned: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  flow: 'bg-rose-100 text-rose-800 dark:bg-rose-500/15 dark:text-rose-300',
  none: 'bg-zinc-200 text-zinc-600 dark:bg-zinc-700/60 dark:text-zinc-300',
};
const KIND_RING: Record<EntryKind, string> = {
  solved: 'border-emerald-500 bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  learned: 'border-amber-500 bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  flow: 'border-rose-500 bg-rose-50 text-rose-800 dark:bg-rose-500/15 dark:text-rose-300',
};

export const kindLabel = (kind: EntryKind | undefined) => (kind ? t(`entry.kind.${kind}`) : t('entry.kind.none'));

export function KindChip({ entry }: { entry: Pick<Entry, 'kind' | 'fromNote'> }) {
  const style = KIND_STYLE[entry.kind ?? 'none'];
  return (
    <span className={`inline-flex h-6 shrink-0 items-center rounded-full px-2.5 text-xs font-medium ${style}`}>
      {entry.kind ? kindLabel(entry.kind) : entry.fromNote ? t('entry.fromNote') : kindLabel(undefined)}
    </span>
  );
}

const sortNewest = (list: Entry[]) => [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));

/**
 * Loads entries (newest first) and keeps them live from the stream. session: one card's entries.
 * keep: which live entries belong in this list (the server's filter can't see sealed fields like the goal).
 * loadMore pages back in time.
 */
export function useEntries(query: { session?: string; since?: string }, keep: (e: Entry) => boolean = () => true, enabled = true) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const keepRef = useRef(keep);
  keepRef.current = keep;
  const PAGE = 200;

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setLoading(true);
    fetchEntries({ ...query, limit: PAGE })
      .then((list) => {
        if (!alive) return;
        // Keep what arrived live while the page was loading (e.g. an old note moved over as the card opened)
        setEntries((prev) => sortNewest([...list, ...prev.filter((p) => !list.some((e) => e.id === p.id))]));
        setMore(list.length === PAGE);
      })
      .catch(() => alive && setEntries([]))
      .finally(() => alive && setLoading(false));
    const off = onEntry((ev) =>
      setEntries((prev) => {
        if (ev.type === 'entry-removed') return prev.filter((e) => e.id !== ev.id);
        const rest = prev.filter((e) => e.id !== ev.entry.id);
        const fits = (query.session === undefined || ev.entry.sessionKey === query.session) && (!query.since || ev.entry.createdAt >= query.since);
        return fits && keepRef.current(ev.entry) ? sortNewest([...rest, ev.entry]) : rest;
      }),
    );
    return () => {
      alive = false;
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.session, query.since, enabled]);

  const loadMore = useCallback(async () => {
    const oldest = entries.at(-1);
    if (!oldest) return;
    const page = await fetchEntries({ ...query, before: oldest.createdAt, limit: PAGE });
    setEntries((prev) => sortNewest([...prev, ...page.filter((e) => !prev.some((p) => p.id === e.id))]));
    setMore(page.length === PAGE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, query.session, query.since]);

  return { entries: entries.filter((e) => keepRef.current(e)), loading, more, loadMore };
}

/** Kind buttons + one or two lines. Enter writes, Shift+Enter breaks the line. Kind is optional */
export function EntryComposer({
  sessionKey,
  goalId,
  where,
  canEdit,
  placeholder,
  compact = false,
}: {
  sessionKey?: string;
  goalId?: string;
  where?: EntryWhere;
  canEdit: boolean;
  placeholder: string;
  /** One row (phone bottom bar, goal view) */
  compact?: boolean;
}) {
  const [kind, setKind] = useState<EntryKind | undefined>();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const submit = async () => {
    const value = text.trim();
    if (!value || busy || !canEdit) return;
    setBusy(true);
    setFailed(false);
    const content: EntryContent = { kind, text: value, ...(goalId ? { goalId } : {}), ...(where ? { where } : {}) };
    try {
      await writeEntry(content, sessionKey);
      setText('');
      setKind(undefined);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="rounded-xl border border-zinc-300 bg-white p-3 dark:border-zinc-700 dark:bg-zinc-900"
    >
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('entry.kind')}>
        {ENTRY_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={kind === k}
            onClick={() => setKind((v) => (v === k ? undefined : k))}
            className={`h-8 rounded-full border px-3 text-xs font-medium ${kind === k ? KIND_RING[k] : 'border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-300'}`}
          >
            {kindLabel(k)}
          </button>
        ))}
        {!compact && <span className="text-xs text-zinc-400">{t('entry.kindOptional')}</span>}
      </div>
      <div className="mt-2.5 flex items-end gap-2">
        <label className="sr-only" htmlFor={`entry-${sessionKey ?? goalId ?? 'journal'}`}>
          {placeholder}
        </label>
        <textarea
          id={`entry-${sessionKey ?? goalId ?? 'journal'}`}
          value={text}
          maxLength={ENTRY_LIMIT}
          rows={compact ? 1 : 2}
          disabled={!canEdit}
          placeholder={canEdit ? placeholder : t('entry.needKey')}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
          className="min-w-0 flex-1 resize-none rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-2 text-base outline-none focus:border-zinc-500 sm:text-sm dark:border-zinc-700 dark:bg-zinc-950"
        />
        <button
          type="submit"
          disabled={!canEdit || busy || !text.trim()}
          className="h-10 shrink-0 rounded-lg bg-zinc-900 px-4 text-sm font-semibold text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {t('entry.write')}
        </button>
      </div>
      <div className="mt-1.5 flex justify-between text-xs text-zinc-400">
        <span>{failed ? <span className="text-red-500">{t('entry.failed')}</span> : compact ? '' : t('entry.enterHint')}</span>
        <span className="tabular-nums">
          {text.length} / {ENTRY_LIMIT}
        </span>
      </div>
    </form>
  );
}

const timeFmt = () => new Intl.DateTimeFormat(getLang(), { hour: 'numeric', minute: '2-digit' });
const dayFmt = () => new Intl.DateTimeFormat(getLang(), { month: 'long', day: 'numeric', weekday: 'short' });
const dayKey = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

/** "Today", "Yesterday", else the date */
function dayLabel(iso: string, now: number): string {
  const key = dayKey(iso);
  if (key === dayKey(new Date(now).toISOString())) return t('entry.today');
  if (key === dayKey(new Date(now - 86_400_000).toISOString())) return t('entry.yesterday');
  return dayFmt().format(new Date(iso));
}

/** Where it was written: the card (its title then, even if the card is gone), and the goal */
function whereText(e: Entry, goals: Goal[] | undefined, sessionKeys: Set<string> | undefined): string | undefined {
  const parts: string[] = [];
  if (e.sessionKey) {
    const title = e.where?.title ?? t('entry.someCard');
    parts.push(sessionKeys && !sessionKeys.has(e.sessionKey) ? `${title} ${t('entry.cardGone')}` : title);
    if (e.where?.project) parts.push(e.where.project);
  }
  const goal = e.goalId && goals?.find((g) => g.id === e.goalId);
  if (goal) parts.push(t('entry.inGoal', { goal: goal.title }));
  return parts.length ? parts.join(' · ') : undefined;
}

function EntryItem({ entry, canEdit, where }: { entry: Entry; canEdit: boolean; where?: string }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(entry.text);
  const [confirm, setConfirm] = useState(false);
  if (entry.locked) return <li className="py-2 text-sm text-zinc-400">🔒 {t('entry.locked')}</li>;
  const save = async () => {
    const value = text.trim();
    if (value && value !== entry.text) await rewriteEntry(entry, { text: value }).catch(() => {});
    setEditing(false);
  };
  return (
    <li className="flex gap-3 rounded-xl border border-zinc-200 bg-white px-3.5 py-3 dark:border-zinc-800 dark:bg-zinc-900/60">
      {/* Actions sit on the time line, so the text keeps the full width on a phone */}
      <KindChip entry={entry} />
      <div className="min-w-0 flex-1">
        {editing ? (
          <textarea
            value={text}
            maxLength={ENTRY_LIMIT}
            rows={2}
            autoFocus
            onChange={(e) => setText(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void save();
              }
              if (e.key === 'Escape') {
                setText(entry.text);
                setEditing(false);
              }
            }}
            className="w-full resize-none rounded-lg border border-zinc-300 bg-zinc-50 px-2 py-1.5 text-base sm:text-sm dark:border-zinc-700 dark:bg-zinc-950"
          />
        ) : (
          <p className="whitespace-pre-wrap break-words text-[0.9375rem] leading-relaxed">{entry.text}</p>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-zinc-400">
          <span className="min-w-0 flex-1">
            <time dateTime={entry.createdAt}>{timeFmt().format(new Date(entry.createdAt))}</time>
            {where && ` · ${where}`}
          </span>
      {canEdit && !editing && (
        <span className="flex shrink-0 items-center gap-1">
          {confirm ? (
            <>
              <button type="button" onClick={() => setConfirm(false)} className="rounded-md px-2 py-1 text-zinc-500">
                {t('entry.cancel')}
              </button>
              <button type="button" onClick={() => deleteEntry(entry.id)} className="rounded-md bg-red-600 px-2 py-1 font-semibold text-white">
                {t('entry.delete')}
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => setEditing(true)} className="rounded-md px-2 py-1 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                {t('entry.edit')}
              </button>
              <button type="button" onClick={() => setConfirm(true)} className="rounded-md px-2 py-1 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                {t('entry.delete')}
              </button>
            </>
          )}
        </span>
      )}
        </div>
      </div>
    </li>
  );
}

/** Entries grouped by day, newest first. showWhere: say which card/goal each came from (journal, goal view) */
export function EntryList({
  entries,
  now,
  canEdit,
  showWhere = false,
  goals,
  sessionKeys,
  empty,
}: {
  entries: Entry[];
  now: number;
  canEdit: boolean;
  showWhere?: boolean;
  goals?: Goal[];
  /** Cards still on the server — entries from others are marked as from a removed card */
  sessionKeys?: Set<string>;
  empty: string;
}) {
  if (entries.length === 0) return <p className="rounded-xl border border-dashed border-zinc-300 px-4 py-6 text-center text-sm text-zinc-400 dark:border-zinc-700">{empty}</p>;
  const days: { label: string; list: Entry[] }[] = [];
  for (const e of entries) {
    const label = dayLabel(e.createdAt, now);
    const last = days.at(-1);
    if (last?.label === label) last.list.push(e);
    else days.push({ label, list: [e] });
  }
  return (
    <div className="space-y-5">
      {days.map((d) => (
        <section key={d.label}>
          <h3 className="mb-2 text-xs font-semibold text-zinc-500">{d.label}</h3>
          <ul className="space-y-2">
            {d.list.map((e) => (
              <EntryItem key={e.id} entry={e} canEdit={canEdit} where={showWhere ? whereText(e, goals, sessionKeys) : undefined} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
