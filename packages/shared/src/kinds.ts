// 이벤트 종류 값 목록 — zod 없이 쓸 수 있게 따로 둔다 (어댑터 번들, 브라우저).
// events.ts 의 zod 스키마가 이 목록으로 만들어진다.

// claude-cloud: 클라우드에서 도는 Claude (Cowork·웹·모바일) — 원격 MCP 커넥터로 보고하고, 서버가 받자마자 받은편지함 키로 잠근다
export const AGENT_SOURCES = ['claude-code', 'codex', 'antigravity', 'claude-desktop', 'claude-cloud', 'manual'] as const;
export type AgentSource = (typeof AGENT_SOURCES)[number];

/**
 * 공통 이벤트 종류. 어댑터는 에이전트 고유 이벤트를 이 중 하나로 정규화한다.
 * 보드 상태 전이는 이 값만 보고 결정한다.
 */
export const AGENT_EVENT_TYPES = [
  'session_start',
  'session_end',
  'prompt', // 사용자가 작업을 지시함 → running
  'tool_start',
  'tool_end',
  'waiting', // 사용자 입력/승인 대기 → waiting_for_you
  'turn_end', // 에이전트 턴 종료 → needs_review
  'subagent_start',
  'subagent_end',
  'error', // API 오류 등으로 턴 실패
  'progress', // MCP 자가보고 / 수동 진행률
  'notice', // 상태에 영향 없는 참고 이벤트 (compact, cwd 변경 등)
] as const;
export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

export const WAITING_REASONS = [
  'permission', // 도구 실행 권한 승인
  'question', // 에이전트가 선택지 질문 (AskUserQuestion)
  'plan', // 계획 승인 (ExitPlanMode)
  'elicitation', // MCP 서버의 입력 요청
  'input', // 그 밖의 입력 요청
  'idle', // 턴 종료 후 다음 지시 대기 (보드에서는 "검토 필요")
  'other',
] as const;
export type WaitingReason = (typeof WAITING_REASONS)[number];
