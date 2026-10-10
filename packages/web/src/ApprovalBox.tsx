import type { ContentKeys } from '@bitl/shared/client';
import { useState } from 'react';
import { type Approval, decide } from './approvals';
import { t } from './i18n';

/**
 * Remote approval request: shows what the agent wants to do, with allow/deny. Used in the card and the detail view.
 * Decisions are signed with this device's key — without a key the buttons are disabled (the PC ignores unsigned decisions).
 */
export function ApprovalBox({ approval, keys, now, full }: { approval: Approval; keys: ContentKeys | null | undefined; now: number; full?: boolean }) {
  const [busy, setBusy] = useState<'allow' | 'deny'>();
  const [result, setResult] = useState<string>();
  const [open, setOpen] = useState(Boolean(full));
  const req = approval.request;
  const left = Math.max(0, Math.round((Date.parse(approval.expiresAt) - now) / 60_000));

  const answer = async (d: 'allow' | 'deny') => {
    if (!keys) return;
    setBusy(d);
    const r = await decide(keys, approval.id, d).catch(() => 'gone' as const);
    setBusy(undefined);
    if (r === 'settled') setResult(t('approval.settled'));
    else if (r === 'gone') setResult(t('approval.gone'));
  };

  return (
    <div className="mt-3 rounded-lg border border-red-200 bg-red-50/60 p-3 dark:border-red-500/30 dark:bg-red-500/10" onClick={(e) => e.stopPropagation()}>
      <p className="text-xs font-semibold text-red-700 dark:text-red-300">
        📱 {t('approval.title')} <span className="font-normal text-red-600/70 dark:text-red-300/70">· {left > 0 ? t('approval.left', { n: left }) : t('approval.soon')}</span>
      </p>
      {req ? (
        <>
          <p className="mt-1 break-all font-mono text-sm text-zinc-800 dark:text-zinc-100">{req.summary}</p>
          {req.description && <p className="mt-0.5 text-xs text-zinc-600 dark:text-zinc-400">{req.description}</p>}
          {req.detail && req.detail !== req.summary.replace(/^[^:]+: /, '') && (
            <>
              {open ? (
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-white/70 p-2 font-mono text-xs text-zinc-700 dark:bg-black/30 dark:text-zinc-300">
                  {req.detail}
                </pre>
              ) : (
                <button type="button" onClick={() => setOpen(true)} className="mt-1 text-xs text-zinc-500 underline underline-offset-2">
                  {t('approval.more')}
                </button>
              )}
            </>
          )}
        </>
      ) : (
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">🔒 {t('approval.locked')}</p>
      )}
      {result ? (
        <p className="mt-2 text-xs text-zinc-500">{result}</p>
      ) : (
        <div className="mt-2.5 flex gap-2">
          <button
            type="button"
            disabled={!keys || !req || busy !== undefined}
            onClick={() => answer('allow')}
            className="flex-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
          >
            {busy === 'allow' ? t('approval.sending') : t('approval.allow')}
          </button>
          <button
            type="button"
            disabled={!keys || busy !== undefined}
            onClick={() => answer('deny')}
            className="flex-1 rounded-lg border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-100 disabled:opacity-40 dark:border-red-500/40 dark:text-red-300 dark:hover:bg-red-500/10"
          >
            {busy === 'deny' ? t('approval.sending') : t('approval.deny')}
          </button>
        </div>
      )}
    </div>
  );
}
