import type { ApprovalAnswers, ContentKeys, PendingQuestion } from '@bitl/shared/client';
import { useState } from 'react';
import { type Approval, decide, markAnswered } from './approvals';
import { t } from './i18n';

/**
 * Remote approval request: shows what the agent wants to do, with allow/deny. Used in the card and the detail view.
 * Decisions are signed with this device's key — without a key the buttons are disabled (the PC ignores unsigned decisions).
 */
export function ApprovalBox({
  approval,
  keys,
  now,
  full,
  statusAt,
}: {
  approval: Approval;
  keys: ContentKeys | null | undefined;
  now: number;
  full?: boolean;
  /** The card's statusAt — once a question is answered here, it stays hidden for this wait (approvals.ts markAnswered) */
  statusAt?: string;
}) {
  const [busy, setBusy] = useState<'allow' | 'deny'>();
  const [result, setResult] = useState<string>();
  const [open, setOpen] = useState(Boolean(full));
  const req = approval.request;
  const left = Math.max(0, Math.round((Date.parse(approval.expiresAt) - now) / 60_000));

  const answer = async (d: 'allow' | 'deny', answers?: ApprovalAnswers) => {
    if (!keys) return;
    setBusy(d);
    const r = await decide(keys, approval.id, d, answers).catch(() => 'gone' as const);
    if (r === 'ok' && answers && statusAt) markAnswered(approval.sessionKey, statusAt);
    setBusy(undefined);
    if (r === 'settled') setResult(t('approval.settled'));
    else if (r === 'gone') setResult(t('approval.gone'));
  };

  return (
    <div className="mt-3 rounded-lg border border-red-200 bg-red-50/60 p-3 dark:border-red-500/30 dark:bg-red-500/10" onClick={(e) => e.stopPropagation()}>
      <p className="text-xs font-semibold text-red-700 dark:text-red-300">
        📱 {t('approval.title')} <span className="font-normal text-red-600/70 dark:text-red-300/70">· {left > 0 ? t('approval.left', { n: left }) : t('approval.soon')}</span>
      </p>
      {req?.questions ? (
        // A question: answered by picking options in the detail (the card points there)
        full && !result ? (
          <QuestionForm questions={req.questions} disabled={!keys || busy !== undefined} sending={busy !== undefined} onSend={(a) => answer('allow', a)} />
        ) : (
          !result && <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">{t('approval.questionHint', { n: req.questions.length })}</p>
        )
      ) : req ? (
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
      ) : req?.questions ? null : (
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

/** Pick an option (or several, or type an answer) for each question, then send them all at once */
function QuestionForm({
  questions,
  disabled,
  sending,
  onSend,
}: {
  questions: PendingQuestion[];
  disabled: boolean;
  sending: boolean;
  onSend: (answers: ApprovalAnswers) => void;
}) {
  const [picked, setPicked] = useState<string[][]>(() => questions.map(() => []));
  const [typed, setTyped] = useState<string[]>(() => questions.map(() => ''));
  const answers = questions.map((_, i) => typed[i]!.trim() || picked[i]!.join(', '));
  const toggle = (i: number, label: string, multi?: boolean) => {
    setPicked((p) => p.map((cur, j) => (j !== i ? cur : multi ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]) : [label])));
    setTyped((p) => p.map((v, j) => (j === i ? '' : v)));
  };
  return (
    <div className="mt-2 space-y-3">
      {questions.map((q, i) => (
        <div key={i}>
          {q.header && <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{q.header}</p>}
          <p className="whitespace-pre-wrap break-words text-sm font-medium text-zinc-800 dark:text-zinc-100">{q.question}</p>
          {q.multiSelect && <p className="mt-0.5 text-xs text-zinc-500">{t('question.multi')}</p>}
          <div className="mt-1.5 space-y-1">
            {q.options.map((o) => {
              const on = picked[i]!.includes(o.label);
              return (
                <button
                  key={o.label}
                  type="button"
                  aria-pressed={on}
                  disabled={disabled}
                  onClick={() => toggle(i, o.label, q.multiSelect)}
                  className={`flex w-full gap-2 rounded-md border px-2 py-1.5 text-left text-sm disabled:opacity-60 ${
                    on
                      ? 'border-emerald-500 bg-emerald-50 dark:border-emerald-400/60 dark:bg-emerald-500/15'
                      : 'border-transparent bg-white/70 hover:border-zinc-300 dark:bg-black/30 dark:hover:border-zinc-600'
                  }`}
                >
                  <span className={`shrink-0 text-xs leading-5 ${on ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-400'}`}>
                    {q.multiSelect ? (on ? '☑' : '☐') : on ? '●' : '○'}
                  </span>
                  <span className="min-w-0">
                    <span className="font-medium text-zinc-800 dark:text-zinc-100">{o.label}</span>
                    {o.description && <span className="block break-words text-xs text-zinc-600 dark:text-zinc-400">{o.description}</span>}
                  </span>
                </button>
              );
            })}
            <input
              type="text"
              value={typed[i]}
              disabled={disabled}
              placeholder={t('approval.typeAnswer')}
              onChange={(e) => {
                const v = e.target.value;
                setTyped((p) => p.map((x, j) => (j === i ? v : x)));
                if (v) setPicked((p) => p.map((cur, j) => (j === i ? [] : cur)));
              }}
              className="w-full rounded-md border border-zinc-200 bg-white/70 px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-black/30"
            />
          </div>
        </div>
      ))}
      <button
        type="button"
        disabled={disabled || !answers.every(Boolean)}
        onClick={() => onSend(Object.fromEntries(questions.map((q, i) => [q.question, answers[i]!])))}
        className="w-full rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
      >
        {sending ? t('approval.sending') : t('approval.sendAnswer')}
      </button>
    </div>
  );
}
