import type { AgentEvent } from './events.js';
import { AGENT_SOURCES, type AgentEventType, type AgentSource, type WaitingReason } from './kinds.js';

type Raw = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

export const oneLine = (s: string, max = 120): string => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Codex may give command as an argv array:["bash", "-lc", "pnpm test"] → "pnpm test" */
function commandText(v: unknown): string | undefined {
  if (!Array.isArray(v)) return str(v);
  const parts = v.filter((x): x is string => typeof x === 'string');
  const shell = parts.length === 3 && /^-l?c$/.test(parts[1] ?? '');
  return str(shell ? parts[2] : parts.join(' '));
}

/** Extracts a one-line summary from tool_input to show on the board. */
export function summarizeToolInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const i = input as Raw;
  // AskUserQuestion: { questions: [{ question, options }] } → first question
  const first = (list: unknown, key: string) => (Array.isArray(list) ? str((list[0] as Raw | undefined)?.[key]) : undefined);
  const pick =
    commandText(i.command) ?? str(i.file_path) ?? str(i.path) ?? str(i.pattern) ??
    str(i.url) ?? str(i.query) ?? str(i.description) ?? str(i.prompt) ??
    first(i.questions, 'question') ?? str(i.plan) ?? // ExitPlanMode: { plan }
    // Codex webrun: { search_query: [{ q }] } or { weather: [{ location }] }
    first(i.search_query, 'q') ?? first(i.weather, 'location');
  return pick ? oneLine(pick) : undefined;
}

/** Claude Code tools where the agent stops until the user answers → waiting reason */
const USER_BLOCKING_TOOLS: Record<string, WaitingReason | undefined> = {
  AskUserQuestion: 'question',
  ExitPlanMode: 'plan',
};

/** Notification.notification_type → waiting reason. undefined if not waiting */
function waitingFromNotification(kind: string | undefined): WaitingReason | undefined {
  switch (kind) {
    case 'permission_prompt':
      return 'permission';
    case 'idle_prompt':
      return 'idle';
    case 'elicitation_dialog':
    case 'elicitation_url_dialog':
      return 'elicitation';
    case 'agent_needs_input':
      return 'input';
    default:
      return undefined;
  }
}

/**
 * Claude Code hooks and Codex hooks share nearly the same event names and common fields, so one handler covers both.
 * https://code.claude.com/docs/en/hooks , https://learn.chatgpt.com/docs/hooks
 */
export function normalizeHook(source: AgentSource, raw: Raw, receivedAt: string): AgentEvent | null {
  const nativeType = str(raw.hook_event_name);
  const sessionId = str(raw.session_id);
  if (!nativeType || !sessionId) return null;

  let type: AgentEventType = 'notice';
  let text: string | undefined;
  let waitingReason: WaitingReason | undefined;
  let tool: AgentEvent['tool'];

  const toolInfo = (failed?: boolean): AgentEvent['tool'] => {
    const name = str(raw.tool_name);
    if (!name) return undefined;
    return {
      name,
      useId: str(raw.tool_use_id),
      summary: summarizeToolInput(raw.tool_input),
      ...(failed ? { failed } : {}),
    };
  };

  switch (nativeType) {
    case 'SessionStart':
      type = 'session_start';
      break;
    case 'SessionEnd':
      type = 'session_end';
      break;
    case 'UserPromptSubmit':
      type = 'prompt';
      // user_prompt per the docs; prompt in older versions/Codex
      text = str(raw.user_prompt) ?? str(raw.prompt);
      break;
    case 'PreToolUse': {
      tool = toolInfo();
      // A tool that only ends when the user answers — "waiting for you", not running. Back to running when it ends (PostToolUse)
      const reason = tool && USER_BLOCKING_TOOLS[tool.name];
      type = reason ? 'waiting' : 'tool_start';
      waitingReason = reason;
      break;
    }
    case 'PostToolUse':
      type = 'tool_end';
      tool = toolInfo();
      break;
    case 'PostToolUseFailure':
      type = 'tool_end';
      tool = toolInfo(true);
      text = str(raw.error_message);
      break;
    case 'PermissionRequest':
      type = 'waiting';
      waitingReason = 'permission';
      tool = toolInfo();
      break;
    case 'Notification': {
      const kind = str(raw.notification_type);
      waitingReason = waitingFromNotification(kind);
      type = waitingReason ? 'waiting' : 'notice';
      text = str(raw.message);
      break;
    }
    case 'Stop':
    case 'Interrupt': // Codex: the in-progress turn was interrupted
      type = 'turn_end';
      text = str(raw.last_assistant_message);
      break;
    case 'StopFailure':
      type = 'error';
      text = str(raw.error_message) ?? str(raw.error_type);
      break;
    case 'SubagentStart':
      type = 'subagent_start';
      text = str(raw.task_description);
      break;
    case 'SubagentStop':
      type = 'subagent_end';
      text = str(raw.last_assistant_message);
      break;
    default:
      type = 'notice';
  }

  return {
    source,
    sessionId,
    type,
    nativeType,
    at: receivedAt,
    cwd: str(raw.cwd),
    turnId: str(raw.turn_id) ?? str(raw.prompt_id),
    agentId: str(raw.agent_id),
    agentType: str(raw.agent_type),
    tool,
    text,
    waitingReason,
    transcriptPath: str(raw.transcript_path),
    model: str(raw.model),
    raw,
  };
}

/**
 * Codex `notify` payload (fallback for environments without hooks). Currently only agent-turn-complete exists.
 * Note the keys are kebab-case.
 */
export function normalizeCodexNotify(raw: Raw, receivedAt: string): AgentEvent | null {
  const nativeType = str(raw.type);
  const sessionId = str(raw['thread-id']);
  if (!nativeType || !sessionId) return null;
  return {
    source: 'codex',
    sessionId,
    type: nativeType === 'agent-turn-complete' ? 'turn_end' : 'notice',
    nativeType,
    at: receivedAt,
    cwd: str(raw.cwd),
    turnId: str(raw['turn-id']),
    text: str(raw['last-assistant-message']),
    raw,
  };
}

/**
 * Antigravity CLI (agy) hooks — https://antigravity.google/docs/hooks/
 * Fields are camelCase and the event name isn't in the payload, so the adapter takes it via --event and puts it in hook_event_name.
 * The question/answer text is missing too, so the adapter fills prompt/last_assistant_message from the transcript (node/antigravity.ts).
 * There are no session start/end or approval-wait events (PreToolUse arrives before the approval prompt) → the adapter derives approval waits from the conversation DB.
 */
type AgyToolCall = { name?: unknown; args?: Raw } | null | undefined;

function agyTool(call: AgyToolCall, failed?: boolean): AgentEvent['tool'] {
  const name = str(call?.name);
  if (!name) return undefined;
  const args = call?.args ?? {};
  const summary = str(args.CommandLine) ?? summarizeToolInput(args) ?? str(args.toolSummary);
  return { name, summary: summary && oneLine(summary), ...(failed ? { failed } : {}) };
}

export function normalizeAntigravity(raw: Raw, receivedAt: string): AgentEvent | null {
  const nativeType = str(raw.hook_event_name);
  const sessionId = str(raw.conversationId);
  if (!nativeType || !sessionId) return null;

  let type: AgentEventType;
  let text: string | undefined;
  let tool: AgentEvent['tool'];
  let waitingReason: WaitingReason | undefined;
  const call = raw.toolCall as AgyToolCall;
  const error = str(raw.error);

  switch (nativeType) {
    case 'PreInvocation':
      // Arrives for every model call within a turn. Only the first call (invocationNum 0) is the user's question
      if (raw.invocationNum !== 0) return null;
      type = 'prompt';
      text = str(raw.prompt);
      break;
    case 'PreToolUse':
      tool = agyTool(call);
      if (!tool) return null;
      type = 'tool_start';
      break;
    case 'PostToolUse':
      tool = agyTool(call, !!error);
      if (!tool) return null; // PostToolUse can arrive with a null toolCall
      type = 'tool_end';
      text = error;
      break;
    case 'Stop':
      type = error ? 'error' : 'turn_end';
      text = error ?? str(raw.last_assistant_message);
      break;
    // The two below come not from agy but from bitl-agy-watch.mjs, based on step state in the conversation DB
    case 'bitl:PermissionWaiting':
      type = 'waiting';
      waitingReason = 'permission';
      tool = agyTool(call);
      break;
    case 'bitl:PermissionResolved': // approved/denied/cancelled → back to in progress (not counted as a tool)
      type = 'progress';
      break;
    default:
      return null; // PostInvocation etc.
  }

  const workspaces = Array.isArray(raw.workspacePaths) ? raw.workspacePaths : [];
  return {
    source: 'antigravity',
    sessionId,
    type,
    nativeType,
    at: receivedAt,
    cwd: str(workspaces[0]),
    tool,
    text,
    waitingReason,
    transcriptPath: str(raw.transcriptPath),
    model: str(raw.modelName),
    raw,
  };
}

/**
 * BITL's own "status report" format — sent by the MCP server (bitl-mcp) and manual tasks (bitl add, web).
 *   { session_id, event: 'start' | 'progress' | 'waiting' | 'done' | 'error' | 'end', title?, detail?, cwd? }
 */
export const REPORT_EVENTS = ['start', 'progress', 'waiting', 'done', 'error', 'end'] as const;
export type ReportEvent = (typeof REPORT_EVENTS)[number];

const REPORT_TYPE: Record<ReportEvent, AgentEventType> = {
  start: 'prompt',
  progress: 'progress',
  waiting: 'waiting',
  done: 'turn_end',
  error: 'error',
  end: 'session_end',
};

export function normalizeReport(source: AgentSource, raw: Raw, receivedAt: string): AgentEvent | null {
  const event = str(raw.event) as ReportEvent | undefined;
  const sessionId = str(raw.session_id);
  if (!event || !sessionId || !(event in REPORT_TYPE)) return null;
  const title = str(raw.title);
  const detail = str(raw.detail);
  return {
    source,
    sessionId,
    type: REPORT_TYPE[event],
    nativeType: `report:${event}`,
    at: receivedAt,
    cwd: str(raw.cwd),
    // For start the title is the instruction itself; for the rest it's the detail
    text: event === 'start' ? (title ?? detail) : detail,
    request: str(raw.request),
    waitingReason: event === 'waiting' ? 'input' : undefined,
    raw,
  };
}

/** Raw input the adapter receives: a hook/notify payload or a status report. source picks the format */
export interface RawRecord {
  /** 'claude-code' | 'codex' | 'codex-notify' | 'antigravity' | 'claude-desktop' | 'manual' */
  source: string;
  receivedAt?: string;
  payload: Raw;
}

export function normalizeRecord(rec: RawRecord): AgentEvent | null {
  // Storage rule: all timestamps are UTC ISO 8601 ('...Z'). Converted to UTC even if they come with an offset.
  // A single format keeps string comparison (e.g. statusAt in state.ts) consistent with time order.
  const at = rec.receivedAt && !Number.isNaN(Date.parse(rec.receivedAt)) ? new Date(rec.receivedAt).toISOString() : new Date().toISOString();
  if (rec.source === 'codex-notify') return normalizeCodexNotify(rec.payload, at);
  if (rec.source === 'antigravity') return normalizeAntigravity(rec.payload, at);
  if (!(AGENT_SOURCES as readonly string[]).includes(rec.source)) return null;
  const source = rec.source as AgentSource;
  // No hook_event_name but an event → BITL status report format (MCP, manual tasks)
  const isReport = typeof rec.payload.event === 'string' && rec.payload.hook_event_name === undefined;
  return isReport ? normalizeReport(source, rec.payload, at) : normalizeHook(source, rec.payload, at);
}
