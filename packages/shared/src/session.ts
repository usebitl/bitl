import type { Sealed } from './crypto.js';
import type { AgentSource, WaitingReason } from './kinds.js';

/** Board card status */
export type SessionStatus =
  | 'running' // the agent is working
  | 'waiting_for_you' // waiting for permission approval or an answer to a question
  | 'needs_review' // turn finished, result needs checking
  | 'idle' // reviewed / no instruction yet
  | 'stale' // running but silent for a long time (process presumed gone)
  | 'error' // turn failed due to an API error etc.
  | 'ended'; // session ended

/** Board kanban column */
export type BoardColumn = 'attention' | 'running' | 'review' | 'rest';

export const columnOf = (status: SessionStatus): BoardColumn => {
  switch (status) {
    case 'waiting_for_you':
    case 'error':
      return 'attention';
    case 'running':
      return 'running';
    case 'needs_review':
      return 'review';
    default:
      return 'rest';
  }
};

/**
 * A session that started (or started and ended) without a single prompt or tool call — e.g. an old session reopened
 * in the Claude Code agent view, or a terminal opened and closed. Kept out of the board columns until it does something.
 * Whatever its status: a session that only relays notifications about other sessions ("X needs your input", "X finished")
 * turns waiting without ever getting a prompt, and would otherwise sit in "waiting for you" as an untitled card.
 */
export const isEmptySession = (s: Pick<SessionSignals, 'turnCount' | 'toolCount'>): boolean => s.turnCount === 0 && s.toolCount === 0;

/**
 * A card's display content. The server holds it only as ciphertext (Sealed); the browser/CLI decrypt it with the key.
 * The server's state machine never reads these values; it only moves the ciphertext carried by events into the right slot.
 */
export const SESSION_CONTENT_FIELDS = [
  'title', // title based on the first prompt
  'aiTitle', // session title from the Claude Code transcript: the user's /rename, else the auto ai-title (shown instead of title if present)
  'currentActivity', // current activity like "Bash: pnpm test"
  'lastPrompt',
  'lastMessage',
  'cwd',
  'project', // git repository top-level folder name (otherwise the cwd folder name)
  'gitBranch',
  'model',
  'note', // a note left by the user
] as const;
export type SessionContentField = (typeof SESSION_CONTENT_FIELDS)[number];

/** The part the server can read (computed by the state machine) */
export interface SessionSignals {
  /** `${source}:${sessionId}` — avoids id collisions across agents. Also used as the ciphertext AAD */
  key: string;
  source: AgentSource;
  sessionId: string;
  status: SessionStatus;
  /** When status last changed. Used so late-arriving events don't roll the status back */
  statusAt: string;
  waitingReason?: WaitingReason;
  turnCount: number;
  toolCount: number;
  subagentsRunning: number;
  startedAt: string;
  lastEventAt: string;
  endedAt?: string;
  archived: boolean;
  /**
   * Swept off the board by "Clear board". Unlike archived, the card comes back (with its history) as soon as the agent
   * works or needs the user again (server state.ts). A cleared session that just ends stays off the board
   */
  cleared?: boolean;
  /** Pinned to the top of the column */
  pinned?: boolean;
  /** Earlier sessions this one continues (`--resume` that started a new session), newest first — their history shows in this card's detail */
  resumedFrom?: string[];
  /** Continued in another session (its key): this card is off the board, its history shows in that card */
  replacedBy?: string;
}

/** Server storage shape: signals + ciphertext */
export interface StoredSession extends SessionSignals {
  enc: Partial<Record<SessionContentField, Sealed>>;
  /** Tag (HMAC) of the last instruction. Checks whether a status report's request is new without knowing its value */
  lastPromptTag?: string;
}

/** Shape used by the UI: decrypted content */
export interface Session extends SessionSignals, Partial<Record<SessionContentField, string>> {
  /** Some content couldn't be opened with this key (encrypted with a different key) */
  locked?: boolean;
}

export interface Turn {
  sessionKey: string;
  turnId?: string;
  prompt?: string;
  result?: string;
  status: 'running' | 'done' | 'error';
  startedAt: string;
  endedAt?: string;
  toolCount: number;
}

export interface StoredTurn extends Omit<Turn, 'prompt' | 'result'> {
  prompt?: Sealed;
  result?: Sealed;
}

export const sessionKey = (source: AgentSource, sessionId: string): string => `${source}:${sessionId}`;

/** Fallback labels for a session without a title — the web app passes translated ones */
export interface TitleLabels {
  locked: string;
  untitled: string;
}
const TITLE_LABELS: TitleLabels = { locked: "🔒 Can't be opened with this device's key", untitled: '(untitled)' };

export const displayTitle = (s: Pick<Session, 'aiTitle' | 'title' | 'project' | 'locked'>, labels: TitleLabels = TITLE_LABELS): string =>
  s.aiTitle ?? s.title ?? s.project ?? (s.locked ? labels.locked : labels.untitled);
