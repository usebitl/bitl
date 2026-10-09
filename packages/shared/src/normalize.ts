import type { AgentEvent } from './events.js';
import { AGENT_SOURCES, type AgentEventType, type AgentSource, type WaitingReason } from './kinds.js';

type Raw = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

export const oneLine = (s: string, max = 120): string => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Codex 는 command 를 argv 배열로 줄 수 있다: ["bash", "-lc", "pnpm test"] → "pnpm test" */
function commandText(v: unknown): string | undefined {
  if (!Array.isArray(v)) return str(v);
  const parts = v.filter((x): x is string => typeof x === 'string');
  const shell = parts.length === 3 && /^-l?c$/.test(parts[1] ?? '');
  return str(shell ? parts[2] : parts.join(' '));
}

/** tool_input 에서 보드에 보여줄 한 줄 요약을 뽑는다. */
export function summarizeToolInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const i = input as Raw;
  // AskUserQuestion: { questions: [{ question, options }] } → 첫 질문
  const first = (list: unknown, key: string) => (Array.isArray(list) ? str((list[0] as Raw | undefined)?.[key]) : undefined);
  const pick =
    commandText(i.command) ?? str(i.file_path) ?? str(i.path) ?? str(i.pattern) ??
    str(i.url) ?? str(i.query) ?? str(i.description) ?? str(i.prompt) ??
    first(i.questions, 'question') ?? str(i.plan) ?? // ExitPlanMode: { plan }
    // Codex webrun: { search_query: [{ q }] } 또는 { weather: [{ location }] }
    first(i.search_query, 'q') ?? first(i.weather, 'location');
  return pick ? oneLine(pick) : undefined;
}

/** 사용자가 답할 때까지 에이전트가 멈추는 Claude Code 도구 → 대기 사유 */
const USER_BLOCKING_TOOLS: Record<string, WaitingReason | undefined> = {
  AskUserQuestion: 'question',
  ExitPlanMode: 'plan',
};

/** Notification.notification_type → 대기 사유. 대기가 아니면 undefined */
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
 * Claude Code hooks 와 Codex hooks 는 이벤트 이름·공통 필드가 거의 같아서 하나로 처리한다.
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
      // 문서상 user_prompt, 구버전/Codex 는 prompt
      text = str(raw.user_prompt) ?? str(raw.prompt);
      break;
    case 'PreToolUse': {
      tool = toolInfo();
      // 사용자가 답해야 끝나는 도구 — 실행 중이 아니라 "나를 기다림". 끝나면(PostToolUse) 다시 running
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
    case 'Interrupt': // Codex: 진행 중 턴이 중단됨
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
 * Codex `notify` 페이로드 (hooks 를 못 쓰는 환경용 폴백). 현재는 agent-turn-complete 만 존재.
 * 키가 kebab-case 인 점에 주의.
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
 * 필드가 camelCase 이고 이벤트 이름이 페이로드에 없어 어댑터가 --event 로 받아 hook_event_name 에 넣는다.
 * 질문·답변 원문도 없어 어댑터가 트랜스크립트에서 prompt·last_assistant_message 를 채운다 (node/antigravity.ts).
 * 세션 시작·종료, 승인 대기 이벤트는 없다 (PreToolUse 는 승인창보다 먼저 온다) → 승인 대기는 어댑터가 대화 DB 를 보고 만든다.
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
      // 턴 안의 모델 호출마다 온다. 첫 호출(invocationNum 0)만 사용자 질문
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
      if (!tool) return null; // toolCall 이 null 인 PostToolUse 가 온다
      type = 'tool_end';
      text = error;
      break;
    case 'Stop':
      type = error ? 'error' : 'turn_end';
      text = error ?? str(raw.last_assistant_message);
      break;
    // 아래 둘은 agy 가 아니라 bitl-agy-watch.mjs 가 대화 DB 의 단계 상태를 보고 만든다
    case 'bitl:PermissionWaiting':
      type = 'waiting';
      waitingReason = 'permission';
      tool = agyTool(call);
      break;
    case 'bitl:PermissionResolved': // 승인·거부·취소 → 다시 진행 중 (도구 수는 세지 않는다)
      type = 'progress';
      break;
    default:
      return null; // PostInvocation 등
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
 * BITL 자체 "상태 보고" 형식 — MCP 서버(bitl-mcp), 수동 작업(bitl add, 웹) 이 보낸다.
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
    // start 는 제목이 곧 지시 내용, 나머지는 상세 설명
    text: event === 'start' ? (title ?? detail) : detail,
    request: str(raw.request),
    waitingReason: event === 'waiting' ? 'input' : undefined,
    raw,
  };
}

/** 어댑터가 받는 원본: hook/notify 페이로드 또는 상태 보고. source 로 형식을 고른다 */
export interface RawRecord {
  /** 'claude-code' | 'codex' | 'codex-notify' | 'antigravity' | 'claude-desktop' | 'manual' */
  source: string;
  receivedAt?: string;
  payload: Raw;
}

export function normalizeRecord(rec: RawRecord): AgentEvent | null {
  // 저장 규칙: 모든 시각은 UTC ISO 8601 ('...Z'). 오프셋이 붙어 와도 UTC 로 바꾼다.
  // 같은 형식이어야 문자열 비교(state.ts 의 statusAt 비교 등)가 시간 순서와 일치한다.
  const at = rec.receivedAt && !Number.isNaN(Date.parse(rec.receivedAt)) ? new Date(rec.receivedAt).toISOString() : new Date().toISOString();
  if (rec.source === 'codex-notify') return normalizeCodexNotify(rec.payload, at);
  if (rec.source === 'antigravity') return normalizeAntigravity(rec.payload, at);
  if (!(AGENT_SOURCES as readonly string[]).includes(rec.source)) return null;
  const source = rec.source as AgentSource;
  // hook_event_name 이 없고 event 가 있으면 BITL 상태 보고 형식 (MCP, 수동 작업)
  const isReport = typeof rec.payload.event === 'string' && rec.payload.hook_event_name === undefined;
  return isReport ? normalizeReport(source, rec.payload, at) : normalizeHook(source, rec.payload, at);
}
