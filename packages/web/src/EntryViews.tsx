import { useCallback, useEffect, useRef, useState } from 'react';
import { deleteEntry, type Entry, ENTRY_LIMIT, type EntryContent, type EntryWhere, fetchEntries, onEntry, rewriteEntry, writeEntry } from './entries';
import type { Goal } from './goals';
import { getLang, t } from './i18n';

/**
 * Entry pieces shared by the card detail ("Notes" tab), the goal view and the journal:
 * the one-line composer, the log grouped by day, and the hook that loads entries and keeps them live.
 */

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

/** Grows the textarea with its text. Empty, or measured while its tab is hidden (scrollHeight 0), it keeps its one-row height */
function fitHeight(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = '';
  if (el.value && el.scrollHeight) el.style.height = `${el.scrollHeight}px`;
}

/** One line that grows as needed. Enter writes, Shift+Enter breaks the line */
export function EntryComposer({
  sessionKey,
  goalId,
  where,
  canEdit,
  placeholder,
}: {
  sessionKey?: string;
  goalId?: string;
  where?: EntryWhere;
  canEdit: boolean;
  placeholder: string;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const id = `entry-${sessionKey ?? goalId ?? 'journal'}`;

  useEffect(() => fitHeight(field.current), [text]);

  const submit = async () => {
    const value = text.trim();
    if (!value || busy || !canEdit) return;
    setBusy(true);
    setFailed(false);
    const content: EntryContent = { text: value, ...(goalId ? { goalId } : {}), ...(where ? { where } : {}) };
    try {
      await writeEntry(content, sessionKey);
      setText('');
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  // The count shows only near the limit, so the bar stays a single quiet line
  const nearLimit = text.length > ENTRY_LIMIT - 60;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-end gap-2 rounded-xl border border-zinc-300 bg-white py-1 pl-3 pr-1 focus-within:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900">
        <span aria-hidden="true" className="self-center font-mono text-sm text-zinc-400">
          ›
        </span>
        <label className="sr-only" htmlFor={id}>
          {placeholder}
        </label>
        <textarea
          ref={field}
          id={id}
          value={text}
          maxLength={ENTRY_LIMIT}
          rows={1}
          disabled={!canEdit}
          placeholder={canEdit ? placeholder : t('entry.needKey')}
          title={t('entry.enterHint')}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
          className="max-h-40 min-w-0 flex-1 resize-none bg-transparent py-1.5 text-base outline-none sm:text-sm"
        />
        <button
          type="submit"
          disabled={!canEdit || busy || !text.trim()}
          className="h-9 shrink-0 rounded-lg bg-zinc-900 px-3.5 text-sm font-semibold text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {t('entry.write')}
        </button>
      </div>
      {(failed || nearLimit) && (
        <div className="mt-1 flex justify-between px-1 text-xs text-zinc-400">
          <span>{failed && <span className="text-red-500">{t('entry.failed')}</span>}</span>
          {nearLimit && (
            <span className="tabular-nums">
              {text.length} / {ENTRY_LIMIT}
            </span>
          )}
        </div>
      )}
    </form>
  );
}

const timeFmt = () => new Intl.DateTimeFormat(getLang(), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
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
  const time = (
    <time dateTime={entry.createdAt} className="pt-0.5 text-xs tabular-nums text-zinc-400">
      {timeFmt().format(new Date(entry.createdAt))}
    </time>
  );
  const row = 'group grid grid-cols-[3rem_minmax(0,1fr)] gap-x-3 border-b border-dashed border-zinc-200 py-2.5 last:border-b-0 dark:border-zinc-800';
  if (entry.locked)
    return (
      <li className={row}>
        {time}
        <p className="text-sm text-zinc-400">🔒 {t('entry.locked')}</p>
      </li>
    );
  const save = async () => {
    const value = text.trim();
    if (value && value !== entry.text) await rewriteEntry(entry, { text: value }).catch(() => {});
    setEditing(false);
  };
  const context = [where, entry.fromNote ? t('entry.fromNote') : undefined].filter(Boolean).join(' · ');
  return (
    <li className={row}>
      {time}
      <div className="min-w-0">
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
        {(context || (canEdit && !editing)) && (
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-zinc-400">
            <span className="min-w-0 flex-1">{context}</span>
            {canEdit && !editing && (
              // Shown on hover where there is one; always shown on touch screens
              <span className={`flex shrink-0 items-center gap-1 ${confirm ? '' : '[@media(hover:hover)]:opacity-0 group-hover:opacity-100 focus-within:opacity-100'}`}>
                {confirm ? (
                  <>
                    <button type="button" onClick={() => setConfirm(false)} className="rounded-md px-2 py-0.5 text-zinc-500">
                      {t('entry.cancel')}
                    </button>
                    <button type="button" onClick={() => deleteEntry(entry.id)} className="rounded-md bg-red-600 px-2 py-0.5 font-semibold text-white">
                      {t('entry.delete')}
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" onClick={() => setEditing(true)} className="rounded-md px-2 py-0.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                      {t('entry.edit')}
                    </button>
                    <button type="button" onClick={() => setConfirm(true)} className="rounded-md px-2 py-0.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                      {t('entry.delete')}
                    </button>
                  </>
                )}
              </span>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

/** Entries as a log grouped by day, newest first. showWhere: say which card/goal each came from (journal, goal view) */
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
          <h3 className="mb-1 text-xs font-semibold text-zinc-500">{d.label}</h3>
          <ul>
            {d.list.map((e) => (
              <EntryItem key={e.id} entry={e} canEdit={canEdit} where={showWhere ? whereText(e, goals, sessionKeys) : undefined} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
