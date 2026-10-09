// 어댑터 → 서버 전송 형식 (v2): 서버가 읽는 신호(평문) + 화면 표시용 내용(암호문).
//
// 1단계 최소화: 원본 페이로드(raw), 도구 입력 전체(수정한 코드 등), 도구 결과(명령 출력 등)는 보내지 않는다.
//   남기는 것은 도구 이름·한 줄 요약, 프롬프트·응답 앞부분뿐이다.
// 2단계 암호화: 남은 내용은 필드마다 봉인한다. 서버의 상태 머신은 신호만으로 돌아간다.
//
// zod 없이 동작해야 한다 — 어댑터 번들과 브라우저에서 쓴다. 서버 쪽 검증은 wire.ts.

import type { Sealed, Sealer } from './crypto.js';
import type { AgentEvent } from './events.js';
import type { AgentEventType, AgentSource, WaitingReason } from './kinds.js';
import { oneLine } from './normalize.js';
import { sessionKey } from './session.js';

export const WIRE_VERSION = 2;

/** 이벤트에 실려 오는 표시용 내용 (전부 암호문으로 전송) */
export const EVENT_CONTENT_FIELDS = [
  'title', // prompt: 카드 제목 (앞부분 한 줄)
  'text', // prompt: 지시 / turn_end: 응답 / error·waiting·progress: 설명 — 앞부분만
  'request', // 상태 보고(MCP): 이번 응답이 답한 요청
  'activity', // "[Explore] Bash: pnpm test"
  'tool',
  'toolSummary',
  'agentType',
  'cwd',
  'project',
  'gitBranch',
  'aiTitle',
  'model',
] as const;
export type EventContentField = (typeof EVENT_CONTENT_FIELDS)[number];
export type EventContent<T = string> = Partial<Record<EventContentField, T>>;

/** 서버가 읽는 신호. 상태 머신에 필요한 것만 */
export interface Signal {
  source: AgentSource;
  sessionId: string;
  type: AgentEventType;
  /** 원본 이벤트 이름 (예: "PreToolUse", "report:done") */
  nativeType: string;
  /** UTC ISO 8601 */
  at: string;
  turnId?: string;
  /** 서브에이전트에서 일어난 이벤트 (무작위 id) */
  agentId?: string;
  /** 서브에이전트 종류가 있는가 — 비어 있으면 Claude Code 내부 작업이라 세지 않는다 */
  agentNamed?: boolean;
  waitingReason?: WaitingReason;
  toolFailed?: boolean;
  /** 지시·요청 내용의 태그(HMAC). 같은 요청인지 값을 모른 채 비교한다 */
  requestTag?: string;
}

export interface WireRecord {
  v: typeof WIRE_VERSION;
  signal: Signal;
  content: EventContent<Sealed>;
}

/** PC 에서만 알 수 있는 부가 정보 (node/enrich.ts) */
export type Enrichment = Pick<EventContent, 'project' | 'gitBranch' | 'aiTitle'>;

/** 질문·응답 원문 한도 (자). 상세 화면에서 전체 응답을 볼 수 있게 넉넉히 — 2026-10-04 500 → 10,000 */
export const TEXT_LIMIT = 10_000;
export const TITLE_LIMIT = 80;

const clip = (s: string, max = TEXT_LIMIT): string => {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** 작업 위치(cwd·프로젝트·브랜치)를 함께 보낼 이벤트. 도구 이벤트마다 보내지 않는다 */
export const carriesContext = (e: Pick<AgentEvent, 'type' | 'nativeType'>): boolean =>
  e.type === 'session_start' || e.type === 'prompt' || e.type === 'turn_end' || e.nativeType === 'CwdChanged';

export function activityOf(e: Pick<AgentEvent, 'tool' | 'agentId' | 'agentType'>): string | undefined {
  if (!e.tool) return undefined;
  const base = e.tool.summary ? `${e.tool.name}: ${e.tool.summary}` : e.tool.name;
  return e.agentId && e.agentType ? `[${e.agentType}] ${base}` : base;
}

/** 정규화된 이벤트 → 신호 + 평문 내용 (봉인 전). 여기서 최소화가 끝난다 */
export function splitEvent(e: AgentEvent, extra: Enrichment = {}): { signal: Signal; content: EventContent; tagSource?: string } {
  const newCwd = e.nativeType === 'CwdChanged' && typeof e.raw.new_cwd === 'string' ? e.raw.new_cwd : undefined;
  const signal: Signal = {
    source: e.source,
    sessionId: e.sessionId,
    type: e.type,
    nativeType: e.nativeType,
    at: e.at,
    turnId: e.turnId,
    agentId: e.agentId,
    agentNamed: e.agentId || e.agentType !== undefined ? Boolean(e.agentType) : undefined,
    waitingReason: e.waitingReason,
    toolFailed: e.tool?.failed || undefined,
  };
  const content: EventContent = {
    title: e.type === 'prompt' && e.text ? oneLine(e.text, TITLE_LIMIT) : undefined,
    text: e.text ? clip(e.text) : undefined,
    request: e.request ? clip(e.request) : undefined,
    activity: activityOf(e),
    tool: e.tool?.name,
    toolSummary: e.tool?.summary,
    agentType: e.agentType || undefined,
    cwd: newCwd ?? (carriesContext(e) ? e.cwd : undefined),
    model: e.model,
    ...extra,
  };
  const tagSource = e.type === 'prompt' ? (e.request ?? e.text) : e.request;
  return { signal: dropUndefined(signal), content: dropUndefined(content), tagSource };
}

function dropUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')) as T;
}

/** 전송할 레코드. 내용은 세션 키를 AAD 로 봉인한다 */
export async function prepareRecord(e: AgentEvent, sealer: Sealer, extra: Enrichment = {}): Promise<WireRecord> {
  const { signal, content, tagSource } = splitEvent(e, extra);
  const aad = sessionKey(e.source, e.sessionId);
  const sealed: EventContent<Sealed> = {};
  await Promise.all(
    (Object.entries(content) as [EventContentField, string][]).map(async ([k, v]) => {
      sealed[k] = await sealer.seal(v, aad);
    }),
  );
  if (tagSource) signal.requestTag = await sealer.tag(tagSource);
  return { v: WIRE_VERSION, signal, content: sealed };
}
