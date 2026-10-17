import { useEffect, useState } from 'react';
import { clearBoard } from './api';
import { t } from './i18n';

/**
 * "Clear": a fresh start when cards pile up. Ended cards are deleted with their history; the rest leave the board
 * until their agent works or needs the user again (cleared), so nothing in progress is lost. Goals go too only if checked.
 * onDone(ok) reports the result (the board shows a toast).
 */
export function ClearDialog({ hasGoals, onClose, onDone }: { hasGoals: boolean; onClose: () => void; onDone: (ok: boolean) => void }) {
  const [goals, setGoals] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async () => {
    setBusy(true);
    const ok = await clearBoard({ goals: hasGoals && goals }).then(
      () => true,
      () => false,
    );
    setBusy(false);
    onDone(ok);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/45 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="clear-dialog-title"
        className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
      >
        <h2 id="clear-dialog-title" className="text-lg font-bold">
          {t('clear.title')}
        </h2>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">{t('clear.body')}</p>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-zinc-600 dark:text-zinc-300">
          <li>{t('clear.ended')}</li>
          <li>{t('clear.active')}</li>
        </ul>
        {hasGoals && (
          <label className="mt-4 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={goals} onChange={(e) => setGoals(e.target.checked)} className="size-4 accent-red-600" />
            {t('clear.goals')}
          </label>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            autoFocus
            onClick={onClose}
            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700"
          >
            {t('clear.cancel')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={submit}
            className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {t('clear.yes')}
          </button>
        </div>
      </div>
    </div>
  );
}
