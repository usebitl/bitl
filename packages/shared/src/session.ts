import type { Sealed } from './crypto.js';
import type { AgentSource, WaitingReason } from './kinds.js';

/** 보드 카드 상태 */
export type SessionStatus =
  | 'running' // 에이전트가 일하는 중
  | 'waiting_for_you' // 권한 승인·질문 응답 대기
  | 'needs_review' // 턴이 끝나 결과 확인 필요
  | 'idle' // 확인 완료 / 아직 지시 없음
  | 'stale' // running 인데 오래 무소식 (프로세스 종료 추정)
  | 'error' // API 오류 등으로 턴 실패
  | 'ended'; // 세션 종료

/** 보드 칸반 열 */
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
 * 카드의 표시용 내용. 서버에는 암호문(Sealed)으로만 있고, 브라우저·CLI 가 키로 풀어 본다.
 * 서버의 상태 머신은 이 값들을 읽지 않고 이벤트에 실려 온 암호문을 알맞은 칸에 옮겨 담기만 한다.
 */
export const SESSION_CONTENT_FIELDS = [
  'title', // 첫 프롬프트 기반 제목
  'aiTitle', // Claude Code 트랜스크립트의 ai-title (있으면 title 대신 표시)
  'currentActivity', // "Bash: pnpm test" 같은 현재 활동
  'lastPrompt',
  'lastMessage',
  'cwd',
  'project', // git 저장소 최상위 폴더 이름 (아니면 cwd 폴더 이름)
  'gitBranch',
  'model',
  'note', // 사용자가 남긴 메모
] as const;
export type SessionContentField = (typeof SESSION_CONTENT_FIELDS)[number];

/** 서버가 읽을 수 있는 부분 (상태 머신이 계산) */
export interface SessionSignals {
  /** `${source}:${sessionId}` — 에이전트 간 id 충돌 방지. 암호문의 AAD 로도 쓴다 */
  key: string;
  source: AgentSource;
  sessionId: string;
  status: SessionStatus;
  /** status 가 마지막으로 바뀐 시각. 늦게 도착한 이벤트가 상태를 되돌리지 않게 하는 데 쓴다 */
  statusAt: string;
  waitingReason?: WaitingReason;
  turnCount: number;
  toolCount: number;
  subagentsRunning: number;
  startedAt: string;
  lastEventAt: string;
  endedAt?: string;
  archived: boolean;
  /** 열 맨 위에 고정 */
  pinned?: boolean;
}

/** 서버 저장 형태: 신호 + 암호문 */
export interface StoredSession extends SessionSignals {
  enc: Partial<Record<SessionContentField, Sealed>>;
  /** 마지막 지시의 태그 (HMAC). 상태 보고의 request 가 새 요청인지 값을 모른 채 비교한다 */
  lastPromptTag?: string;
}

/** 화면에서 쓰는 형태: 복호화한 내용 */
export interface Session extends SessionSignals, Partial<Record<SessionContentField, string>> {
  /** 이 키로 풀 수 없는 내용이 있었다 (다른 키로 암호화됨) */
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

export const displayTitle = (s: Pick<Session, 'aiTitle' | 'title' | 'project' | 'locked'>): string =>
  s.aiTitle ?? s.title ?? s.project ?? (s.locked ? '🔒 이 기기의 키로 열 수 없음' : '(제목 없음)');

/** 세션 상세 타임라인 한 줄 */
export interface TimelineItem {
  at: string;
  type: string;
  nativeType: string;
  agentType?: string;
  tool?: { name: string; summary?: string; failed?: boolean };
  text?: string;
  waitingReason?: string;
}

export const TIMELINE_CONTENT_FIELDS = ['tool', 'toolSummary', 'agentType', 'text'] as const;
export type TimelineContentField = (typeof TIMELINE_CONTENT_FIELDS)[number];

export interface StoredTimelineItem {
  at: string;
  type: string;
  nativeType: string;
  waitingReason?: string;
  toolFailed?: boolean;
  content: Partial<Record<TimelineContentField, Sealed>>;
}
