import { z } from 'zod';
import { AGENT_EVENT_TYPES, AGENT_SOURCES, WAITING_REASONS } from './kinds.js';

/** 이벤트를 보낸 에이전트 종류 */
export const AgentSource = z.enum(AGENT_SOURCES);
export type AgentSource = z.infer<typeof AgentSource>;
/** 공통 이벤트 종류 (kinds.ts 참고) */
export const AgentEventType = z.enum(AGENT_EVENT_TYPES);
export type AgentEventType = z.infer<typeof AgentEventType>;
export const WaitingReason = z.enum(WAITING_REASONS);
export type WaitingReason = z.infer<typeof WaitingReason>;

/**
 * 정규화된 이벤트. 어댑터(PC) 안에서만 쓰인다 — 서버로는 prepare.ts 가 신호(평문)와 내용(암호문)으로 나눠 보낸다.
 * raw 는 원본 페이로드로, 어댑터 밖으로 나가지 않는다.
 */
export const AgentEvent = z.object({
  source: AgentSource,
  sessionId: z.string().min(1),
  type: AgentEventType,
  /** 원본 이벤트 이름 (예: "PreToolUse", "agent-turn-complete") */
  nativeType: z.string(),
  at: z.string().datetime(),
  cwd: z.string().optional(),
  turnId: z.string().optional(),
  /** 서브에이전트에서 발생한 이벤트면 해당 id */
  agentId: z.string().optional(),
  agentType: z.string().optional(),
  tool: z
    .object({
      name: z.string(),
      useId: z.string().optional(),
      /** 보드에 보여줄 한 줄 요약 (예: "src/app.ts", "pnpm test") */
      summary: z.string().optional(),
      failed: z.boolean().optional(),
    })
    .optional(),
  /** prompt: 사용자 프롬프트 / turn_end: 마지막 응답 / error: 오류 메시지 */
  text: z.string().optional(),
  /** 상태 보고(MCP·수동) 전용: 이 응답이 답한 사용자 요청 요약. 새 값이면 새 턴으로 기록한다 */
  request: z.string().optional(),
  waitingReason: WaitingReason.optional(),
  transcriptPath: z.string().optional(),
  model: z.string().optional(),
  /** 원본 페이로드 (정규화 규칙용. 서버로 보내지 않는다) */
  raw: z.record(z.string(), z.unknown()),
});
export type AgentEvent = z.infer<typeof AgentEvent>;
