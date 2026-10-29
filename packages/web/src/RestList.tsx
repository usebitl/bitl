import { displayTitle, type Session } from '@bitl/shared/client';
import { SOURCE_CHIP } from './EndedSection';
import { localTime, SOURCE_LABEL } from './format';
import { t, titleLabels } from './i18n';

/**
 * The "Idle" sessions — reviewed and waiting for the next instruction. They are looked up rather than read,
 * so they get one compact row each instead of a full card: a narrow rail beside the three work columns on wide
 * boards, rows below them on narrow ones
 */
export function RestList({
  sessions,
  now,
  selectedKey,
  onOpen,
  empty,
}: {
  sessions: Session[];
  now: number;
  selectedKey: string | null;
  onOpen: (key: string) => void;
  empty: string;
}) {
  return (
    <section aria-label={t('app.col.rest')} className="bitl-rest min-w-0 @5xl:border-l @5xl:border-zinc-200 @5xl:pl-4 @5xl:dark:border-zinc-800">
      <h2 className="bitl-col-title mb-2 flex items-center gap-2 px-1 text-sm font-semibold text-zinc-600 dark:text-zinc-300">
        <span className="size-2.5 rounded-full bg-zinc-400" />
        {t('app.col.rest')}
        <span className="font-normal text-zinc-400">{sessions.length}</span>
      </h2>
      {sessions.length === 0 ? (
        <p className="bitl-empty rounded-xl border border-dashed border-zinc-200 px-3 py-4 text-center text-sm text-zinc-400 dark:border-zinc-800">{empty}</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-1 @5xl:grid-cols-1">
          {sessions.map((s) => (
            <button
              key={s.key}
              type="button"
              aria-current={s.key === selectedKey || undefined}
              onClick={() => onOpen(s.key)}
              className={`grid min-h-11 gap-0.5 rounded-lg px-2 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800/70 ${
                s.key === selectedKey ? 'bg-zinc-100 ring-1 ring-zinc-300 dark:bg-zinc-800/70 dark:ring-zinc-700' : ''
              }`}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                {s.pinned && (
                  <span title={t('card.pinned')} className="shrink-0 text-xs">
                    📌
                  </span>
                )}
                <span className="truncate text-sm font-medium">{displayTitle(s, titleLabels())}</span>
              </span>
              <span className="flex min-w-0 items-center gap-1.5 text-xs text-zinc-500">
                <span className={`shrink-0 rounded px-1 text-[11px] font-medium ${SOURCE_CHIP[s.source]}`}>{SOURCE_LABEL[s.source]}</span>
                <span className="min-w-0 truncate font-mono">{s.project ?? ''}</span>
                <span className="ml-auto shrink-0">{localTime(s.lastEventAt, now)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
