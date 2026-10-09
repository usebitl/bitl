import type { ContentKeys } from '@bitl/shared/client';
import { displayTitle, type Session } from '@bitl/shared/session';
import { useState } from 'react';
import { ApprovalBox } from './ApprovalBox';
import { deleteSession, postAction, reportManual } from './api';
import type { Approval } from './approvals';
import { agoPhrase, elapsed, localDateTime, minutesSince, promptText, SOURCE_LABEL, WAITING_LABEL } from './format';
import { CardGoalMenu, GoalBadges } from './GoalViews';
import { t } from './i18n';
import type { Goal } from './goals';

const SOURCE_STYLE: Record<Session['source'], string> = {
  'claude-code': 'bg-orange-100 text-orange-800 dark:bg-orange-500/15 dark:text-orange-300',
  codex: 'bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300',
  antigravity: 'bg-violet-100 text-violet-800 dark:bg-violet-500/15 dark:text-violet-300',
  'claude-desktop': 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  'claude-cloud': 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  manual: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700/50 dark:text-zinc-300',
};

/**
 * 상태 아이콘 — BITL 로고 그대로(끊긴 고리 + 빨간 점). 실행 중이면 고리와 점이 함께 돌고,
 * 나를 기다리면 멈춰서 고리가 흐려진다.
 * 색은 상태 문구 색(currentColor)을 따른다. 그 밖의 상태에는 없다 (움직이는 것과 내 차례만 눈에 띄게)
 */
function StatusIcon({ status }: { status: Session['status'] }) {
  if (status !== 'running' && status !== 'waiting_for_you') return null;
  const running = status === 'running';
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" className="size-[18px] shrink-0">
      <g className={running ? 'bitl-spin' : undefined}>
        <circle
          cx="32"
          cy="32"
          r="16"
          fill="none"
          stroke="currentColor"
          strokeWidth={7}
          strokeLinecap="round"
          strokeDasharray="80 20.53"
          className={running ? undefined : 'opacity-45'}
        />
        <circle cx="44.8" cy="22.4" r="7" className="fill-red-500" />
      </g>
    </svg>
  );
}

/** 상태 문구 + 기준 시각. 마우스를 올리면 사용자 시간대의 절대 시각을 보여준다 */
function StatusLine({ s, now }: { s: Session; now: number }) {
  const RED = 'font-medium text-red-600 dark:text-red-400';
  const [text, at, cls] = ((): [string, string, string] => {
    switch (s.status) {
      case 'waiting_for_you':
        return [`${WAITING_LABEL[s.waitingReason ?? 'other']} · ${elapsed(s.statusAt, now)}`, s.statusAt, RED];
      case 'error':
        return [t('card.error'), s.statusAt, RED];
      case 'running':
        return [t(s.source === 'manual' ? 'card.progressing' : 'card.working', { e: elapsed(s.statusAt, now) }), s.statusAt, 'text-emerald-700 dark:text-emerald-400'];
      case 'needs_review':
        return [t('card.done', { t: agoPhrase(s.statusAt, now) }), s.statusAt, 'text-amber-700 dark:text-amber-400'];
      case 'stale':
        return [t('card.stale', { t: agoPhrase(s.lastEventAt, now) }), s.lastEventAt, 'text-zinc-500'];
      case 'ended':
        return [t('card.ended', { t: agoPhrase(s.endedAt ?? s.lastEventAt, now) }), s.endedAt ?? s.lastEventAt, 'text-zinc-500'];
      default:
        return [t('card.active', { t: agoPhrase(s.lastEventAt, now) }), s.lastEventAt, 'text-zinc-500'];
    }
  })();
  return (
    <p className={`flex items-center gap-1.5 text-sm ${cls}`}>
      <StatusIcon status={s.status} />
      <time dateTime={at} title={localDateTime(at)}>
        {text}
      </time>
    </p>
  );
}

const BTN_PRIMARY =
  'flex-1 rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white';
const BTN_SECONDARY =
  'flex-1 rounded-lg border border-zinc-200 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800';

/** 카드 하단 버튼. 에이전트 세션은 "확인"만, 수동 작업은 사람이 상태를 직접 바꾼다 */
function Actions({ s }: { s: Session }) {
  const canAck = s.status === 'needs_review' || s.status === 'error' || s.status === 'stale';
  const manualOpen = s.source === 'manual' && (s.status === 'running' || s.status === 'waiting_for_you');
  if (!canAck && !manualOpen) return null;

  return (
    <div className="mt-3 flex gap-2">
      {manualOpen &&
        (s.status === 'running' ? (
          <button type="button" className={BTN_SECONDARY} onClick={() => reportManual(s.sessionId, 'waiting')}>
            {t('card.manualWaiting')}
          </button>
        ) : (
          <button type="button" className={BTN_SECONDARY} onClick={() => reportManual(s.sessionId, 'progress', { detail: t('card.manualResume') })}>
            {t('card.manualResume')}
          </button>
        ))}
      {manualOpen && (
        <button type="button" className={BTN_PRIMARY} onClick={() => reportManual(s.sessionId, 'end')}>
          {t('card.manualDone')}
        </button>
      )}
      {canAck && (
        <button type="button" className={BTN_PRIMARY} onClick={() => postAction(s.key, 'ack')}>
          {t('card.ack')}
        </button>
      )}
    </div>
  );
}

/**
 * 삭제 확인 줄. 브라우저 confirm() 대신 페이지 안에서 한 번 더 묻는다 (모바일 웹뷰에서도 동작).
 * 지우면 턴·타임라인 기록까지 사라지고, 그 세션에서 에이전트가 계속 일하면 새 카드로 다시 나타난다.
 */
export function DeleteConfirm({ s, onCancel, onDeleted }: { s: Session; onCancel: () => void; onDeleted?: () => void }) {
  return (
    <div className="mt-3 rounded-lg bg-red-50 p-2.5 text-sm dark:bg-red-500/10">
      <p className="mb-2 text-red-700 dark:text-red-300">{t('card.deleteConfirm')}</p>
      <div className="flex gap-2">
        <button
          type="button"
          className="flex-1 rounded-lg bg-red-600 px-3 py-1.5 font-medium text-white hover:bg-red-700"
          onClick={() => deleteSession(s.key).then(onDeleted)}
        >
          {t('card.delete')}
        </button>
        <button type="button" className={BTN_SECONDARY} onClick={onCancel}>
          {t('card.cancel')}
        </button>
      </div>
    </div>
  );
}

export function SessionCard({
  s,
  now,
  selected,
  onOpen,
  approval,
  keys,
  goals,
  onNewGoal,
}: {
  s: Session;
  now: number;
  selected?: boolean;
  onOpen: () => void;
  /** 원격 승인 요청 (이 카드의 가장 오래된 것) */
  approval?: Approval;
  keys?: ContentKeys | null;
  /** 목표 (카드의 ◎ 메뉴로 넣고 뺀다). 없으면 메뉴를 숨긴다 */
  goals?: Goal[];
  /** 이 카드를 넣은 새 목표 만들기 */
  onNewGoal?: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const urgent = s.status === 'waiting_for_you' && minutesSince(s.statusAt, now) >= 5;
  // 현재 활동 → (끝났으면) 마지막 응답 순으로 한 줄 요약
  const title = displayTitle(s);
  // 마지막 지시 — 제목(ai-title·첫 프롬프트)과 같으면 중복이라 생략
  const prompt = promptText(s.lastPrompt);
  const lastPrompt = prompt && prompt.replace(/\s+/g, ' ').trim() !== title ? prompt : undefined;
  // 진행 중·대기 중이면 지금 하는 일, 끝났으면 마지막 응답
  const finished = s.status === 'needs_review' || s.status === 'error';
  const activity = finished ? undefined : s.currentActivity;
  const response = finished ? s.lastMessage : undefined;

  return (
    <article
      className={[
        'group relative rounded-xl border bg-white p-3.5 shadow-sm transition hover:shadow-md dark:bg-zinc-900/70',
        s.status === 'waiting_for_you' || s.status === 'error' ? 'border-red-300 dark:border-red-500/40' : 'border-zinc-200 dark:border-zinc-800',
        urgent ? 'pulse-ring' : '',
        s.status === 'ended' || s.status === 'stale' ? 'opacity-70' : '',
        selected ? 'ring-2 ring-sky-500 ring-offset-2 ring-offset-zinc-50 dark:ring-offset-[#0b0d12]' : '',
      ].join(' ')}
    >
      {/* 삭제: 데스크톱은 카드에 마우스를 올리면, 터치 화면은 항상 보인다 */}
      <button
        type="button"
        onClick={() => setConfirmDelete(true)}
        title={t('card.deleteTitle')}
        aria-label={t('card.deleteTitle')}
        className="absolute right-2 top-2 rounded-md px-1.5 py-0.5 text-sm text-zinc-400 hover:bg-zinc-100 hover:text-red-600 focus:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 dark:hover:bg-zinc-800"
      >
        ✕
      </button>
      {goals && onNewGoal && <CardGoalMenu sessionKey={s.key} goals={goals} onNewGoal={onNewGoal} />}
      <button type="button" onClick={onOpen} className="block w-full text-left">
        <div className="mb-1.5 flex items-center gap-2 pr-12 text-xs">
          <span
            className={`shrink-0 rounded-md px-1.5 py-0.5 font-medium ${SOURCE_STYLE[s.source]}`}
            title={s.source === 'claude-cloud' ? t('card.cloudTitle') : undefined}
          >
            {SOURCE_LABEL[s.source]}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-zinc-500 dark:text-zinc-400">
            {s.project ?? ''}
            {s.gitBranch && <span className="text-zinc-400 dark:text-zinc-500"> @{s.gitBranch}</span>}
          </span>
          {s.pinned && <span title={t('card.pinned')}>📌</span>}
        </div>
        <h3 className="line-clamp-2 font-semibold leading-snug">{title}</h3>
        <div className="mt-1">
          <StatusLine s={s} now={now} />
        </div>
        {lastPrompt && (
          <p className="mt-1.5 line-clamp-2 break-words text-sm text-zinc-700 dark:text-zinc-300" title={t('card.lastPrompt')}>
            <span className="mr-1 text-zinc-400">💬</span>
            {lastPrompt}
          </p>
        )}
        {activity && <p className="mt-1.5 line-clamp-2 break-all font-mono text-xs text-zinc-600 dark:text-zinc-400">{activity}</p>}
        {response && (
          <p className="mt-1.5 line-clamp-2 break-words text-xs text-zinc-600 dark:text-zinc-400" title={t('card.lastResponse')}>
            <span className="mr-1 text-zinc-400">↳</span>
            {response}
          </p>
        )}
        {s.note && <p className="mt-1.5 line-clamp-2 text-xs text-sky-700 dark:text-sky-400">📝 {s.note}</p>}
        {s.source !== 'manual' && (
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-500">
            <span>{t('card.turns', { n: s.turnCount })}</span>
            <span>{t('card.tools', { n: s.toolCount })}</span>
            {s.subagentsRunning > 0 && <span className="text-violet-600 dark:text-violet-400">{t('card.subagents', { n: s.subagentsRunning })}</span>}
          </div>
        )}
      </button>
      {goals && <GoalBadges sessionKey={s.key} goals={goals} />}
      {approval && <ApprovalBox approval={approval} keys={keys} now={now} />}
      {confirmDelete ? <DeleteConfirm s={s} onCancel={() => setConfirmDelete(false)} /> : <Actions s={s} />}
    </article>
  );
}
