import type { Session } from '@bitl/shared/session';
import { t } from './i18n';

/**
 * Prompt as shown in the instruction history. Claude Code also delivers notices that background work (subagents, shells) finished
 * as user prompts (UserPromptSubmit) — show a one-line label instead of the raw text (<task-notification>…).
 */
export function promptText(p: string | undefined): string | undefined {
  if (!p?.trimStart().startsWith('<task-notification>')) return p;
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(p)?.[1]?.trim();
  return `⚙ ${t('prompt.taskNotice')}${summary ? ` · ${summary}` : ''}`;
}

/** Elapsed time (duration only). Korean "방금 / 3분 / 2시간 5분 / 3일", English "just now / 3 min / 2 h 5 min / 3 d" */
export function ago(iso: string, now: number): string {
  const sec = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (sec < 45) return t('time.now');
  const min = Math.round(sec / 60);
  if (min < 60) return t('time.min', { n: min });
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? t('time.hmin', { h, m: min % 60 }) : t('time.h', { n: h });
  return t('time.d', { n: Math.floor(h / 24) });
}

/** When (for use in a sentence): Korean "3분 전" / "방금" — English "3 min ago" / "just now" */
export function agoPhrase(iso: string, now: number): string {
  const a = ago(iso, now);
  return a === t('time.now') ? a : t('time.ago', { d: a });
}

/** How long so far (running/waiting): Korean "3분째" / "방금" — English uses the plain duration "3 min" */
export function elapsed(iso: string, now: number): string {
  const a = ago(iso, now);
  return a === t('time.now') ? a : t('time.elapsed', { d: a });
}

// All server data is UTC ISO 8601. Converted to the browser's locale and time zone only for display (locale = undefined → user environment)
const dateTimeFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const shortDateTimeFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; // by local date

/** Full timestamp for tooltips (e.g. "2026. 9. 26. 오전 8:27:18") */
export const localDateTime = (iso: string): string => dateTimeFmt.format(new Date(iso));

/** Time only if today, otherwise date + time */
export function localTime(iso: string, now: number): string {
  const d = new Date(iso);
  return dayKey(d) === dayKey(new Date(now)) ? timeFmt.format(d) : shortDateTimeFmt.format(d);
}

export const minutesSince =(iso: string, now: number) => (now - Date.parse(iso)) / 60_000;

/** What it is waiting for (in the UI language — current language on each read) */
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
