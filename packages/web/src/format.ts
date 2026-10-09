import type { Session } from '@bitl/shared/session';
import { t } from './i18n';

/**
 * 지시 기록에 보일 프롬프트. Claude Code 는 백그라운드 작업(서브에이전트·셸)이 끝났다는 알림도
 * 사용자 프롬프트(UserPromptSubmit)로 넘긴다 — 원문(<task-notification>…) 대신 한 줄 표시로.
 */
export function promptText(p: string | undefined): string | undefined {
  if (!p?.trimStart().startsWith('<task-notification>')) return p;
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(p)?.[1]?.trim();
  return `⚙ ${t('prompt.taskNotice')}${summary ? ` · ${summary}` : ''}`;
}

/** 지난 시간 (길이만). 한국어 "방금 / 3분 / 2시간 5분 / 3일", 영어 "just now / 3 min / 2 h 5 min / 3 d" */
export function ago(iso: string, now: number): string {
  const sec = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (sec < 45) return t('time.now');
  const min = Math.round(sec / 60);
  if (min < 60) return t('time.min', { n: min });
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? t('time.hmin', { h, m: min % 60 }) : t('time.h', { n: h });
  return t('time.d', { n: Math.floor(h / 24) });
}

/** 언제 (문장에 넣을 때): "3분 전" / "방금" — 영어 "3 min ago" / "just now" */
export function agoPhrase(iso: string, now: number): string {
  const a = ago(iso, now);
  return a === t('time.now') ? a : t('time.ago', { d: a });
}

/** 얼마째 (진행 중·대기 중): "3분째" / "방금" — 영어는 길이 그대로 "3 min" */
export function elapsed(iso: string, now: number): string {
  const a = ago(iso, now);
  return a === t('time.now') ? a : t('time.elapsed', { d: a });
}

// 서버 데이터는 모두 UTC ISO 8601. 표시할 때만 브라우저의 로캘·시간대로 변환한다 (locale = undefined → 사용자 환경)
const dateTimeFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const shortDateTimeFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; // 로컬 날짜 기준

/** 툴팁용 전체 시각 (예: "2026. 9. 26. 오전 8:27:18") */
export const localDateTime = (iso: string): string => dateTimeFmt.format(new Date(iso));

/** 오늘이면 시각만, 아니면 날짜+시각 */
export function localTime(iso: string, now: number): string {
  const d = new Date(iso);
  return dayKey(d) === dayKey(new Date(now)) ? timeFmt.format(d) : shortDateTimeFmt.format(d);
}

export const minutesSince =(iso: string, now: number) => (now - Date.parse(iso)) / 60_000;

/** 무엇을 기다리는지 (화면 언어로 — 읽을 때마다 현재 언어) */
export const WAITING_LABEL: Record<string, string> = {
  get permission() {
    return t('wait.permission');
  },
  get question() {
    return t('wait.question');
  },
  get plan() {
    return t('wait.plan');
  },
  get elicitation() {
    return t('wait.elicitation');
  },
  get input() {
    return t('wait.input');
  },
  get idle() {
    return t('wait.input');
  },
  get other() {
    return t('wait.other');
  },
};

export const SOURCE_LABEL: Record<Session['source'], string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity',
  'claude-desktop': 'Claude',
  'claude-cloud': 'Claude ☁',
  get manual() {
    return t('source.manual');
  },
};

export function resumeCommand(s: Session): string | undefined {
  if (s.source === 'claude-code') return `claude --resume ${s.sessionId}`;
  if (s.source === 'codex') return `codex resume ${s.sessionId}`;
  if (s.source === 'antigravity') return `agy --conversation ${s.sessionId}`;
  return undefined;
}
