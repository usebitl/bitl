import { type ContentKeys, TEXT_LIMIT } from '@bitl/shared/client';
import { CopyField } from './Copy';
import { t } from './i18n';
import { ApprovalBox } from './ApprovalBox';
import type { Approval } from './approvals';
import { displayTitle, type Session, type TimelineItem, type Turn } from '@bitl/shared/session';
import { useEffect, useRef, useState } from 'react';
import { fetchDetail, patchSession, postAction, type SessionDetail as Detail } from './api';
import { localDateTime, localTime, promptText, resumeCommand, SOURCE_LABEL, WAITING_LABEL } from './format';
import { DeleteConfirm } from './SessionCard';

/**
 * 상세 보기 방식
 * - side: 오른쪽 패널. 보드를 가리지 않아 병렬 세션 흐름을 계속 보면서 확인한다 (다른 카드를 누르면 내용만 바뀜)
 * - wide: 화면 중앙의 넓은 레이어. 지시 기록과 타임라인을 나란히 보며 한 세션을 자세히 본다
 * 모바일(좁은 화면)은 둘 다 전체 화면이다.
 */
export type DetailMode = 'side' | 'wide';

/** side 패널 폭 — App 이 보드 오른쪽 여백을 같은 값으로 비운다 */
export const SIDE_PANEL_CLASS = 'sm:w-[34rem]';
export const SIDE_PANEL_GUTTER = 'sm:pr-[35.5rem]'; // 패널 폭 + 1.5rem 여백

const TIMELINE_ICON: Record<string, string> = {
  prompt: '💬',
  tool_start: '🔧',
  tool_end: '⚠️',
  waiting: '✋',
  turn_end: '✅',
  subagent_start: '🧩',
  subagent_end: '🧩',
  error: '❌',
  session_start: '▶️',
  session_end: '⏹️',
  progress: '⏳',
};

/** 화면 문구. 이 파일은 턴·타임라인 항목을 t 로 부르는 곳이 많아 msg 로 쓴다 */
const msg = t;

function timelineText(t: TimelineItem): string {
  if (t.tool) return `${t.tool.name}${t.tool.summary ? `: ${t.tool.summary}` : ''}${t.tool.failed && t.text ? ` — ${t.text}` : ''}`;
  if (t.type === 'waiting') return `${WAITING_LABEL[t.waitingReason ?? 'other']}${t.text ? ` — ${t.text}` : ''}`;
  if (t.type === 'session_start') return msg('detail.sessionStart');
  if (t.type === 'session_end') return msg('detail.sessionEnd');
  if (t.type === 'subagent_start') return `${msg('detail.subagentStart')}${t.text ? ` — ${t.text}` : ''}`;
  if (t.type === 'subagent_end') return msg('detail.subagentEnd');
  return (t.type === 'prompt' ? promptText(t.text) : t.text) ?? t.nativeType;
}

function Time({ iso, now }: { iso: string; now: number }) {
  return (
    <time dateTime={iso} title={localDateTime(iso)} className="shrink-0 tabular-nums text-zinc-400">
      {localTime(iso, now)}
    </time>
  );
}

/**
 * 에이전트 응답. 길면 12줄로 접고 "전체 보기"로 펼친다.
 * PC 의 어댑터가 1만 자에서 자르므로 (shared/prepare.ts TEXT_LIMIT) 그 한도에 닿은 응답은 잘렸다고 알린다
 */
function ResultText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && !open) setOverflows(el.scrollHeight > el.clientHeight + 2);
  }, [text, open]);
  const clipped = text.length >= TEXT_LIMIT - 1 && text.endsWith('…');
  return (
    <div className="mt-2 border-l-2 border-zinc-200 pl-3 dark:border-zinc-700">
      <p ref={ref} className={`whitespace-pre-wrap break-words text-sm text-zinc-600 dark:text-zinc-400 ${open ? '' : 'line-clamp-[12]'}`}>
        {text}
      </p>
      {open && clipped && <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-400">{t('detail.clipped', { n: TEXT_LIMIT.toLocaleString() })}</p>}
      {(overflows || open) && (
        <button type="button" onClick={() => setOpen((v) => !v)} className="mt-1.5 text-xs font-medium text-sky-600 hover:underline dark:text-sky-400">
          {open ? t('detail.less') : t('detail.more')}
        </button>
      )}
    </div>
  );
}

function TurnList({ turns, now }: { turns: Turn[]; now: number }) {
  if (turns.length === 0) return <p className="text-sm text-zinc-400">{msg('detail.noTurns')}</p>;
  return (
    <ol className="space-y-4">
      {turns.map((t, i) => (
        <li key={`${t.startedAt}-${i}`} className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
          <div className="mb-1.5 flex items-center gap-2 text-xs">
            <Time iso={t.startedAt} now={now} />
            <span className={t.status === 'error' ? 'text-red-500' : t.status === 'running' ? 'text-emerald-500' : 'text-zinc-400'}>
              {t.status === 'running' ? msg('detail.turnRunning') : t.status === 'error' ? msg('detail.turnError') : msg('detail.turnDone')}
            </span>
            <span className="text-zinc-400">{msg('card.tools', { n: t.toolCount })}</span>
          </div>
          <p className="whitespace-pre-wrap break-words text-sm font-medium">{promptText(t.prompt) ?? msg('detail.noPrompt')}</p>
          {t.result && <ResultText text={t.result} />}
        </li>
      ))}
    </ol>
  );
}

function Timeline({ items, now }: { items: TimelineItem[]; now: number }) {
  if (items.length === 0) return <p className="text-sm text-zinc-400">{msg('detail.noEvents')}</p>;
  return (
    <ol className="space-y-1.5 font-mono text-xs">
      {items.map((t, i) => (
        <li key={`${t.at}-${i}`} className="flex gap-2">
          <Time iso={t.at} now={now} />
          <span className="shrink-0">{TIMELINE_ICON[t.type] ?? '·'}</span>
          <span className={`min-w-0 break-all ${t.tool?.failed || t.type === 'error' ? 'text-red-500' : 'text-zinc-700 dark:text-zinc-300'}`}>
            {t.agentType && <span className="text-violet-500">[{t.agentType}] </span>}
            {timelineText(t)}
          </span>
        </li>
      ))}
    </ol>
  );
}

interface Props {
  session: Session;
  now: number;
  mode: DetailMode;
  /** 상세를 보는 동안 다른 세션이 나를 기다리는지 (wide 모드는 보드를 가리므로 알려준다) */
  attentionCount: number;
  onToggleMode: () => void;
  onClose: () => void;
  /** 원격 승인 요청 (이 카드의 가장 오래된 것) */
  approval?: Approval;
  keys?: ContentKeys | null;
}

export function SessionDetail({ session, now, mode, attentionCount, onToggleMode, onClose, approval, keys }: Props) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [tab, setTab] = useState<'turns' | 'timeline'>('turns');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [note, setNote] = useState(session.note ?? '');
  const noteDirty = useRef(false);
  const wide = mode === 'wide';

  // 세션에 새 이벤트가 오면 상세도 다시 읽는다
  useEffect(() => {
    let alive = true;
    fetchDetail(session.key).then((d) => alive && setDetail(d));
    return () => {
      alive = false;
    };
  }, [session.key, session.lastEventAt, session.turnCount]);

  useEffect(() => {
    if (!noteDirty.current) setNote(session.note ?? '');
  }, [session.note]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const saveNote = async () => {
    if (!noteDirty.current) return;
    noteDirty.current = false;
    // 키가 없으면 암호화할 수 없어 저장하지 않는다 (평문을 서버에 보내지 않음) — 다음에 다시 시도
    await patchSession(session.key, { note }).catch(() => {
      noteDirty.current = true;
    });
  };

  const resume = resumeCommand(session);
  const turns = detail?.turns ?? [];
  const timeline = detail?.timeline ?? [];
  // 이 세션을 뺀 나머지 중 나를 기다리는 수
  const othersWaiting = attentionCount - (session.status === 'waiting_for_you' || session.status === 'error' ? 1 : 0);

  const panel = (
    <aside
      className={[
        'relative flex w-full flex-col overflow-hidden bg-white shadow-2xl dark:bg-zinc-950',
        wide
          ? 'h-full sm:h-[88vh] sm:max-w-6xl sm:rounded-2xl sm:border sm:border-zinc-200 sm:dark:border-zinc-800'
          : `h-full border-zinc-200 sm:border-l dark:border-zinc-800 ${SIDE_PANEL_CLASS}`,
      ].join(' ')}
    >
      {wide && othersWaiting > 0 && (
        <button
          type="button"
          onClick={onClose}
          className="bg-red-500 px-5 py-1.5 text-left text-sm font-medium text-white hover:bg-red-600"
        >
          {msg('detail.othersWaiting', { n: othersWaiting })}
        </button>
      )}

      <header className="border-b border-zinc-200 px-5 pb-4 pt-[max(1rem,env(safe-area-inset-top))] dark:border-zinc-800">
        <div className="flex items-start gap-1">
          <div className="min-w-0 flex-1 pr-2">
            <div className="mb-1 truncate font-mono text-xs text-zinc-500">
              {SOURCE_LABEL[session.source]} · {session.project ?? '?'}
              {session.gitBranch && ` @${session.gitBranch}`}
            </div>
            <h2 className="text-lg font-bold leading-snug">{displayTitle(session)}</h2>
          </div>
          <button
            type="button"
            onClick={() => patchSession(session.key, { pinned: !session.pinned })}
            className={`rounded-lg px-2 py-1 text-lg ${session.pinned ? '' : 'opacity-30 hover:opacity-70'}`}
            title={session.pinned ? msg('detail.unpin') : msg('detail.pin')}
          >
            📌
          </button>
          <button
            type="button"
            onClick={onToggleMode}
            className="hidden rounded-lg px-2 py-1 text-lg text-zinc-400 hover:text-zinc-700 sm:block dark:hover:text-zinc-200"
            title={wide ? msg('detail.sideMode') : msg('detail.wideMode')}
          >
            {wide ? '⇥' : '⤢'}
          </button>
          <button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-xl text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200" title={msg('detail.closeEsc')}>
            ✕
          </button>
        </div>

        <div className={wide ? 'mt-2 grid gap-3 lg:grid-cols-[1fr_1fr] lg:items-start' : 'mt-2'}>
          <div className="space-y-2">
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
              <span>
                {msg('detail.started')} <Time iso={session.startedAt} now={now} />
              </span>
              <span>
                {msg('detail.lastActive')} <Time iso={session.lastEventAt} now={now} />
              </span>
              <span>
                {msg('card.turns', { n: session.turnCount })} · {msg('card.tools', { n: session.toolCount })}
              </span>
            </div>
            {resume && (
              <CopyField text={resume} />
            )}
          </div>
          <textarea
            value={note}
            onChange={(e) => {
              noteDirty.current = true;
              setNote(e.target.value);
            }}
            onBlur={saveNote}
            placeholder={msg('detail.notePlaceholder')}
            rows={2}
            className={`w-full resize-none rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm outline-none focus:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:focus:border-zinc-600 ${wide ? '' : 'mt-3'}`}
          />
        </div>
        {approval && <ApprovalBox approval={approval} keys={keys} now={now} full />}
      </header>

      {/* 지시 기록 / 타임라인은 탭으로 전환 (넓게 보기도 같다 — 지시와 응답을 넓게 읽게, 타임라인은 필요할 때만) */}
      <nav className="border-b border-zinc-200 px-5 dark:border-zinc-800">
        <div className={`flex gap-1 ${wide ? 'mx-auto max-w-[900px]' : ''}`}>
        {(
          [
            ['turns', msg('detail.tabTurns', { n: turns.length })],
            ['timeline', msg('detail.tabTimeline', { n: timeline.length })],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === id ? 'border-zinc-900 font-semibold dark:border-zinc-100' : 'border-transparent text-zinc-500'}`}
          >
            {label}
          </button>
        ))}
        </div>
      </nav>

      <div className="min-h-0 flex-1">
        {(['turns', 'timeline'] as const).map((id) => (
          <section
            key={id}
            className={['h-full overflow-y-auto px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]', tab === id ? '' : 'hidden'].join(' ')}
          >
            {/* 넓게 보기: 화면 폭을 쓰되 한 줄이 너무 길어지지 않게 본문은 가운데 약 900px */}
            <div className={wide ? 'mx-auto max-w-[900px]' : undefined}>
            {!detail ? (
              <p className="text-sm text-zinc-400">{msg('detail.loading')}</p>
            ) : id === 'turns' ? (
              <TurnList turns={turns} now={now} />
            ) : (
              <Timeline items={timeline} now={now} />
            )}
            </div>
          </section>
        ))}
      </div>

      <footer className="border-t border-zinc-200 px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] dark:border-zinc-800">
        {confirmDelete ? (
          <div className="-mt-3">
            <DeleteConfirm s={session} onCancel={() => setConfirmDelete(false)} onDeleted={onClose} />
          </div>
        ) : (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => postAction(session.key, session.archived ? 'unarchive' : 'archive').then(onClose)}
              className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
            >
              {session.archived ? msg('detail.unarchive') : msg('detail.archive')}
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="ml-auto rounded-lg border border-red-200 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:border-red-500/30 dark:text-red-400 dark:hover:bg-red-500/10"
            >
              {msg('card.delete')}
            </button>
          </div>
        )}
      </footer>
    </aside>
  );

  if (wide) {
    return (
      <div className="fixed inset-0 z-30 flex items-center justify-center sm:p-6">
        <button type="button" aria-label={msg('detail.close')} onClick={onClose} className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" />
        {panel}
      </div>
    );
  }
  // side: 배경을 막지 않는다 — 보드는 계속 보이고 클릭할 수 있다 (모바일은 전체 화면)
  return <div className="fixed inset-y-0 right-0 z-30 flex w-full sm:w-auto">{panel}</div>;
}
