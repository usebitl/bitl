import { type EventContent, type Sealed, type Signal, type StoredSession, sessionKey } from '@bitl/shared';

/** 이벤트 적용 결과 턴 테이블에 반영할 변화. prompt·result 는 암호문 그대로 */
export type TurnOp =
  | { op: 'start'; turnId?: string; prompt?: Sealed; at: string }
  | { op: 'end'; turnId?: string; result?: Sealed; status: 'done' | 'error'; at: string }
  | { op: 'tool'; turnId?: string };

export const STALE_AFTER_MS = 10 * 60 * 1000;
/**
 * 에이전트는 PreToolUse 직후 PermissionRequest 를 보내는데 두 async hook 이 수십 ms 차이로 동시에 떠서
 * PreToolUse 가 더 늦은 시각으로 찍히기도 한다 (Codex 에서 18ms 차이 확인). 권한 대기 직후 이만큼 안에
 * 온 도구 시작은 같은 도구의 PreToolUse 로 보고 대기를 유지한다. 승인 후엔 PostToolUse 가 대기를 푼다
 */
export const PERMISSION_RACE_MS = 2000;

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
 * 세션 상태 머신. 순수 함수 — 이전 세션과 이벤트를 받아 다음 세션을 돌려준다.
 *
 * 서버는 내용을 읽지 못한다: 상태는 신호(e)만 보고 정하고, 내용(c, 암호문)은 알맞은 칸에 옮겨 담기만 한다.
 * 값이 있는지 없는지만 본다 (예: 응답이 있으면 lastMessage 를 그 암호문으로).
 *
 * hook 은 async 로 실행되어 도착 순서가 뒤바뀔 수 있다 (예: Stop 이 마지막 PostToolUse 보다 먼저 도착).
 * 그래서 상태를 마지막으로 바꾼 시각(statusAt)보다 이른 이벤트는 카운터만 갱신하고 상태는 바꾸지 않는다.
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
   * refresh: 같은 상태라도 기준 시각을 새로 잡는다.
   * 예) 대화에서 턴이 또 끝남(needs_review → needs_review), 새 질문으로 다시 대기 — "N분 전 완료/N분째 대기"가 맞게 보이도록
   */
  const setStatus = (status: StoredSession['status'], refresh = false) => {
    if (late || (s.status === status && !refresh)) return;
    s.status = status;
    s.statusAt = e.at;
    if (status !== 'waiting_for_you') s.waitingReason = undefined;
  };
  /** 내용 칸 갱신. undefined 면 비운다 */
  const put = (field: keyof StoredSession['enc'], value: Sealed | undefined) => {
    if (value === undefined) delete s.enc[field];
    else s.enc[field] = value;
  };

  if (e.at > s.lastEventAt) s.lastEventAt = e.at;
  // 작업 위치·부가 정보는 어댑터가 PC 에서 구해 보낸다 (git 저장소 기준 프로젝트 이름, 브랜치, ai-title)
  for (const field of ['cwd', 'project', 'gitBranch', 'aiTitle', 'model'] as const) if (c[field]) put(field, c[field]);

  // 서브에이전트 안에서 일어난 이벤트는 부모 세션의 턴 상태를 바꾸지 않는다
  const fromSubagent = Boolean(e.agentId) && e.type !== 'subagent_start' && e.type !== 'subagent_end';

  // 상태 보고(MCP)에 새 사용자 요청이 담겨 오면 그 요청을 새 턴으로 연다 — 같은 요청인지는 태그로 비교.
  // Claude Desktop 채팅은 hook 이 없어 응답 끝의 보고 한 번으로 "요청 → 응답" 한 턴을 기록한다.
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
      // 상태 보고의 start: text 는 작업 제목, request 는 사용자의 실제 요청
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
      // 권한 승인 후 도구가 실행 완료됨 → 다시 running
      if (s.status === 'waiting_for_you' || s.status === 'stale' || s.status === 'idle') setStatus('running');
      break;

    case 'waiting':
      if (e.waitingReason === 'idle') {
        // idle_prompt: 턴 종료 후 입력을 기다리는 중. 승인 대기보다는 "검토 필요"에 가깝다
        if (s.status !== 'waiting_for_you') setStatus('needs_review');
        break;
      }
      setStatus('waiting_for_you', true);
      if (!late) {
        s.waitingReason = e.waitingReason;
        // 무엇을 기다리는지: 도구(권한·질문) 또는 보고에 담긴 설명(MCP·수동 작업의 "확인이 필요해…")
        const act = c.activity ?? c.text;
        if (act) put('currentActivity', act);
      }
      // 상태 보고의 waiting 은 "응답을 질문으로 끝냄" — 그 턴의 결과로 남긴다
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
      // agent_type 이 빈 SubagentStart/Stop 은 Claude Code 내부 작업이라 보드에 표시하지 않는다
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
      // CwdChanged 의 새 위치는 위에서 c.cwd 로 반영됐다
      break;
  }

  return { session: s, turns };
}

/** running 인데 오래 무소식이면 stale. 대기 상태는 사람이 원인이라 stale 로 보지 않는다. */
export function markStale(s: StoredSession, now: Date, afterMs = STALE_AFTER_MS): StoredSession | null {
  if (s.status !== 'running') return null;
  if (now.getTime() - Date.parse(s.lastEventAt) < afterMs) return null;
  return { ...s, status: 'stale', statusAt: now.toISOString() };
}

/** 사용자가 카드에서 "확인"을 누름 */
export function acknowledge(s: StoredSession, now: Date): StoredSession | null {
  if (!['needs_review', 'error', 'stale'].includes(s.status)) return null;
  return { ...s, status: 'idle', statusAt: now.toISOString(), waitingReason: undefined };
}
