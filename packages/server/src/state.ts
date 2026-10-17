import { type EventContent, type Sealed, type Signal, type StoredSession, sessionKey } from '@bitl/shared';

/** Turn-table change resulting from applying an event. prompt/result stay ciphertext */
export type TurnOp =
  | { op: 'start'; turnId?: string; prompt?: Sealed; at: string }
  | { op: 'end'; turnId?: string; result?: Sealed; status: 'done' | 'error'; at: string }
  | { op: 'tool'; turnId?: string };

export const STALE_AFTER_MS = 10 * 60 * 1000;
/**
 * The agent sends PermissionRequest right after PreToolUse, but the two async hooks fire within tens of ms of each other,
 * so PreToolUse is sometimes stamped later (an 18 ms gap seen in Codex). A tool start arriving within this window
 * after a permission wait is treated as that tool's PreToolUse and the wait is kept. After approval, PostToolUse clears it
 */
export const PERMISSION_RACE_MS = 2000;

/** Events that do not bring a cleared card back to the board */
const QUIET_EVENTS = new Set<Signal['type']>(['session_start', 'session_end', 'notice']);

function newSession(e: Signal): StoredSession {
  return {
    key: sessionKey(e.source, e.sessionId),
    source: e.source,
    sessionId: e.sessionId,
    status: 'idle',
    statusAt: e.at,
    turnCount: 0,
    toolCount: 0,
    subagentsRunning: 0,
    startedAt: e.at,
    lastEventAt: e.at,
    archived: false,
    enc: {},
  };
}

/**
 * Session state machine. Pure function — takes the previous session and an event, returns the next session.
 *
 * The server can't read content: status is decided from the signal (e) alone, and content (c, ciphertext) is just copied into the right field.
 * Only presence is checked (e.g. if there's a response, lastMessage becomes that ciphertext).
 *
 * Hooks run async, so arrival order can flip (e.g. Stop arrives before the last PostToolUse).
 * So events older than the last status change (statusAt) only update counters, not the status.
 */
export function applyEvent(
  prev: StoredSession | undefined,
  e: Signal,
  c: EventContent<Sealed> = {},
): { session: StoredSession; turns: TurnOp[] } {
  const base = prev ?? newSession(e);
  const s: StoredSession = { ...base, enc: { ...base.enc } };
  const late = e.at < s.statusAt;
  const turns: TurnOp[] = [];
  const isReport = e.nativeType.startsWith('report:');

  /**
   * refresh: reset the reference time even if the status is unchanged.
   * e.g. another turn ends in a chat (needs_review → needs_review), or waiting again on a new question — so "done N min ago / waiting for N min" stays correct
   */
  const setStatus = (status: StoredSession['status'], refresh = false) => {
    if (late || (s.status === status && !refresh)) return;
    s.status = status;
    s.statusAt = e.at;
    if (status !== 'waiting_for_you') s.waitingReason = undefined;
  };
  /** Content field updates. undefined clears the field */
  const put = (field: keyof StoredSession['enc'], value: Sealed | undefined) => {
    if (value === undefined) delete s.enc[field];
    else s.enc[field] = value;
  };

  if (e.at > s.lastEventAt) s.lastEventAt = e.at;
  // A cleared card returns to the board when the agent works or needs the user again — not on a session start/end,
  // an informational notice, the idle reminder that follows a finished turn, or an event that arrived out of order (late)
  if (s.cleared && !late && !QUIET_EVENTS.has(e.type) && e.waitingReason !== 'idle') delete s.cleared;
  // The working directory and extra info come from the adapter on the PC (project name from the git repo, branch, ai-title)
  for (const field of ['cwd', 'project', 'gitBranch', 'aiTitle', 'model'] as const) if (c[field]) put(field, c[field]);

  // Events from inside a subagent don't change the parent session's turn state
  const fromSubagent = Boolean(e.agentId) && e.type !== 'subagent_start' && e.type !== 'subagent_end';

  // If a status report (MCP) carries a new user request, open it as a new turn — sameness is compared by tag.
  // Claude Desktop chats have no hooks, so a single report at the end of a reply records one "request → response" turn.
  if (e.requestTag && e.type !== 'prompt' && e.requestTag !== s.lastPromptTag) {
    s.lastPromptTag = e.requestTag;
    put('lastPrompt', c.request);
    s.turnCount += 1;
    turns.push({ op: 'start', turnId: e.turnId, prompt: c.request, at: e.at });
  }

  switch (e.type) {
    case 'session_start':
      if (!prev || s.status === 'ended') setStatus('idle');
      s.endedAt = undefined;
      break;

    case 'prompt': {
      if (fromSubagent) break;
      setStatus('running');
      // Status report start: text is the task title, request is the user's actual request
      const prompt = c.request ?? c.text;
      put('lastPrompt', prompt);
      s.lastPromptTag = e.requestTag;
      if (!s.enc.title && c.title) s.enc.title = c.title;
      s.turnCount += 1;
      put('currentActivity', undefined);
      s.endedAt = undefined;
      turns.push({ op: 'start', turnId: e.turnId, prompt, at: e.at });
      break;
    }

    case 'tool_start': {
      s.toolCount += 1;
      turns.push({ op: 'tool', turnId: e.turnId });
      const racedPermission =
        s.status === 'waiting_for_you' && s.waitingReason === 'permission' && Date.parse(e.at) - Date.parse(s.statusAt) < PERMISSION_RACE_MS;
      if (racedPermission) break;
      if (!late) put('currentActivity', c.activity);
      if (s.status !== 'ended') setStatus('running');
      break;
    }

    case 'tool_end':
      // Tool finished after permission was granted → back to running
      if (s.status === 'waiting_for_you' || s.status === 'stale' || s.status === 'idle') setStatus('running');
      break;

    case 'waiting':
      if (e.waitingReason === 'idle') {
        // idle_prompt: waiting for input after the turn ended. Closer to "needs review" than to awaiting approval
        if (s.status !== 'waiting_for_you') setStatus('needs_review');
        break;
      }
      setStatus('waiting_for_you', true);
      if (!late) {
        s.waitingReason = e.waitingReason;
        // What it's waiting on: the tool (permission/question) or the description in the report (an MCP/manual task's "need confirmation…")
        const act = c.activity ?? c.text;
        if (act) put('currentActivity', act);
      }
      // A status report's waiting means "the reply ended with a question" — keep it as that turn's result
      if (isReport) {
        if (!late && c.text) put('lastMessage', c.text);
        turns.push({ op: 'end', turnId: e.turnId, result: c.text, status: 'done', at: e.at });
      }
      break;

    case 'turn_end':
      if (fromSubagent) break;
      setStatus('needs_review', true);
      if (!late) {
        put('lastMessage', c.text);
        put('currentActivity', undefined);
      }
      turns.push({ op: 'end', turnId: e.turnId, result: c.text, status: 'done', at: e.at });
      break;

    case 'subagent_start':
      // SubagentStart/Stop with an empty agent_type are Claude Code internals and aren't shown on the board
      if (e.agentNamed) s.subagentsRunning += 1;
      break;

    case 'subagent_end':
      if (e.agentNamed) s.subagentsRunning = Math.max(0, s.subagentsRunning - 1);
      break;

    case 'error':
      setStatus('error', true);
      if (!late) put('lastMessage', c.text);
      turns.push({ op: 'end', turnId: e.turnId, result: c.text, status: 'error', at: e.at });
      break;

    case 'session_end':
      setStatus('ended');
      s.endedAt = e.at;
      put('currentActivity', undefined);
      s.subagentsRunning = 0;
      break;

    case 'progress':
      setStatus('running');
      if (c.text) put('currentActivity', c.text);
      break;

    case 'notice':
      // CwdChanged's new location was already applied above via c.cwd
      break;
  }

  return { session: s, turns };
}

/** running with no news for a long time → stale. Waiting states are on the human, so they never go stale. */
export function markStale(s: StoredSession, now: Date, afterMs = STALE_AFTER_MS): StoredSession | null {
  if (s.status !== 'running') return null;
  if (now.getTime() - Date.parse(s.lastEventAt) < afterMs) return null;
  return { ...s, status: 'stale', statusAt: now.toISOString() };
}

/** The user acknowledged the card */
export function acknowledge(s: StoredSession, now: Date): StoredSession | null {
  if (!['needs_review', 'error', 'stale'].includes(s.status)) return null;
  return { ...s, status: 'idle', statusAt: now.toISOString(), waitingReason: undefined };
}
