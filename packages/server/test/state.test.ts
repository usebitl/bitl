import { type Enrichment, type EventContent, normalizeHook, type Signal, type StoredSession, splitEvent } from '@bitl/shared';
import { describe, expect, it } from 'vitest';
import { acknowledge, applyEvent, markStale } from '../src/state.js';

// 상태 머신은 내용을 읽지 않는다 — 여기서는 봉인하지 않은 평문을 그대로 넣어 어느 칸에 옮겨 담는지 확인한다
type Ev = { signal: Signal; content: EventContent };

let clock = Date.parse('2026-09-26T00:00:00.000Z');
const t = (plusSec = 1) => new Date((clock += plusSec * 1000)).toISOString();

const hook = (name: string, extra: Record<string, unknown> = {}, at = t(), enrichment: Enrichment = {}): Ev => {
  const e = normalizeHook('claude-code', { session_id: 's1', cwd: 'C:/work/api/', hook_event_name: name, ...extra }, at)!;
  const { signal, content, tagSource } = splitEvent(e, enrichment);
  return { signal: { ...signal, requestTag: tagSource }, content };
};

const step = (s: StoredSession | undefined, e: Ev) => applyEvent(s, e.signal, e.content);

/** 이벤트를 순서대로 적용한 최종 세션 */
const run = (...events: Ev[]): StoredSession => {
  let s: StoredSession | undefined;
  for (const e of events) s = step(s, e).session;
  return s!;
};

/** 비교하기 쉽게 내용 칸을 펼친다 */
const v = (s: StoredSession) => ({ ...s, ...s.enc });

describe('applyEvent', () => {
  it('새 세션은 idle, 작업 위치·프로젝트는 이벤트에 실린 값 (프로젝트 이름은 어댑터가 git 기준으로 정함)', () => {
    const s = run(hook('SessionStart', { source: 'startup' }, t(), { project: 'api', gitBranch: 'main' }));
    expect(v(s)).toMatchObject({ key: 'claude-code:s1', status: 'idle', cwd: 'C:/work/api/', project: 'api', gitBranch: 'main', turnCount: 0 });
  });

  it('프롬프트 → running, 첫 프롬프트가 제목', () => {
    const s = run(hook('UserPromptSubmit', { prompt: '로그인 버그 고쳐줘' }), hook('UserPromptSubmit', { prompt: '두번째' }));
    expect(v(s)).toMatchObject({ status: 'running', title: '로그인 버그 고쳐줘', lastPrompt: '두번째', turnCount: 2 });
  });

  it('도구 사용은 현재 활동과 카운트를 갱신', () => {
    const s = run(
      hook('UserPromptSubmit', { prompt: 'x' }),
      hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'pnpm test' } }),
    );
    expect(v(s)).toMatchObject({ status: 'running', currentActivity: 'Bash: pnpm test', toolCount: 1 });
  });

  it('권한 대기 → waiting_for_you, 승인 후 도구 완료 → running', () => {
    const waiting = run(
      hook('UserPromptSubmit', { prompt: 'x' }),
      hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } }),
      hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } }),
    );
    expect(v(waiting)).toMatchObject({ status: 'waiting_for_you', waitingReason: 'permission', currentActivity: 'Bash: rm -rf dist' });

    const resumed = step(waiting, hook('PostToolUse', { tool_name: 'Bash' })).session;
    expect(resumed.status).toBe('running');
    expect(resumed.waitingReason).toBeUndefined();
  });

  it('PreToolUse 가 PermissionRequest 보다 몇 ms 늦게 찍혀도(async hook 경쟁) 권한 대기를 유지', () => {
    const at = Date.parse(t());
    const iso = (ms: number) => new Date(at + ms).toISOString();
    const s = run(
      hook('UserPromptSubmit', { prompt: 'x' }, iso(-5000)),
      hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } }, iso(0)),
      hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } }, iso(18)),
    );
    expect(v(s)).toMatchObject({ status: 'waiting_for_you', waitingReason: 'permission', currentActivity: 'Bash: rm -rf dist', toolCount: 1 });
    // 대기 뒤 한참 지나 시작한 도구는 대기를 끝낸 것으로 본다
    expect(step(s, hook('PreToolUse', { tool_name: 'Read' }, iso(5000))).session.status).toBe('running');
  });

  it('Stop → needs_review, 마지막 응답 저장', () => {
    const s = run(hook('UserPromptSubmit', { prompt: 'x' }), hook('Stop', { last_assistant_message: '고쳤습니다' }));
    expect(v(s)).toMatchObject({ status: 'needs_review', lastMessage: '고쳤습니다' });
  });

  it('idle_prompt 는 승인 대기가 아니라 검토 필요로 본다', () => {
    const s = run(hook('UserPromptSubmit', { prompt: 'x' }), hook('Stop'), hook('Notification', { notification_type: 'idle_prompt' }));
    expect(s.status).toBe('needs_review');
  });

  it('늦게 도착한 PostToolUse 가 needs_review 를 running 으로 되돌리지 않는다', () => {
    const prompt = hook('UserPromptSubmit', { prompt: 'x' });
    const toolAt = t();
    const stopAt = t();
    const s = run(
      prompt,
      hook('Stop', {}, stopAt),
      hook('PostToolUse', { tool_name: 'Bash' }, toolAt), // Stop 보다 먼저 발생했지만 늦게 도착
    );
    expect(s.status).toBe('needs_review');
  });

  it('서브에이전트의 Stop 은 부모 턴을 끝내지 않는다', () => {
    const s = run(
      hook('UserPromptSubmit', { prompt: 'x' }),
      hook('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' }),
      hook('PreToolUse', { agent_id: 'a1', agent_type: 'Explore', tool_name: 'Grep', tool_input: { pattern: 'foo' } }),
      hook('Stop', { agent_id: 'a1', agent_type: 'Explore' }),
    );
    expect(v(s)).toMatchObject({ status: 'running', subagentsRunning: 1, currentActivity: '[Explore] Grep: foo' });
    expect(step(s, hook('SubagentStop', { agent_id: 'a1', agent_type: 'Explore' })).session.subagentsRunning).toBe(0);
  });

  it('agent_type 이 빈 내부 서브에이전트는 세지 않는다', () => {
    const s = run(hook('SubagentStop', { agent_id: 'x', agent_type: '' }));
    expect(s.subagentsRunning).toBe(0);
  });

  it('StopFailure → error, SessionEnd → ended, 재시작하면 idle', () => {
    const err = run(hook('UserPromptSubmit', { prompt: 'x' }), hook('StopFailure', { error_type: 'rate_limit' }));
    expect(v(err)).toMatchObject({ status: 'error', lastMessage: 'rate_limit' });
    const ended = step(err, hook('SessionEnd', { reason: 'other' })).session;
    expect(ended.status).toBe('ended');
    expect(ended.endedAt).toBeDefined();
    const back = step(ended, hook('SessionStart', { source: 'resume' })).session;
    expect(back.status).toBe('idle');
    expect(back.endedAt).toBeUndefined();
  });

  it('턴 변화를 함께 돌려준다', () => {
    const start = step(undefined, hook('UserPromptSubmit', { prompt: 'p', prompt_id: 'p1' }));
    expect(start.turns).toEqual([expect.objectContaining({ op: 'start', turnId: 'p1', prompt: 'p' })]);
    const end = step(start.session, hook('Stop', { prompt_id: 'p1', last_assistant_message: 'r' }));
    expect(end.turns).toEqual([expect.objectContaining({ op: 'end', turnId: 'p1', result: 'r', status: 'done' })]);
  });

  it('CwdChanged 는 새 위치로, 실려 오지 않은 부가 정보는 그대로', () => {
    const s = run(hook('SessionStart', {}, t(), { project: 'api' }), hook('CwdChanged', { new_cwd: 'C:/work/api/packages/web' }));
    expect(v(s)).toMatchObject({ cwd: 'C:/work/api/packages/web', project: 'api' });
  });

  it('도구 이벤트는 작업 위치를 싣지 않아도 기존 값을 지우지 않는다', () => {
    const s = run(hook('UserPromptSubmit', { prompt: 'x' }), hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }));
    expect(s.enc.cwd).toBe('C:/work/api/');
  });
});

describe('markStale / acknowledge', () => {
  it('running 이 10분 무소식이면 stale, 대기 상태는 그대로', () => {
    const running = run(hook('UserPromptSubmit', { prompt: 'x' }));
    const later = new Date(Date.parse(running.lastEventAt) + 11 * 60_000);
    expect(markStale(running, later)?.status).toBe('stale');
    expect(markStale(running, new Date(Date.parse(running.lastEventAt) + 60_000))).toBeNull();

    const waiting = step(running, hook('PermissionRequest', { tool_name: 'Bash' })).session;
    expect(markStale(waiting, later)).toBeNull();
  });

  it('검토 필요 → 확인 → idle, running 은 확인 불가', () => {
    const review = run(hook('UserPromptSubmit', { prompt: 'x' }), hook('Stop'));
    expect(acknowledge(review, new Date())?.status).toBe('idle');
    expect(acknowledge(run(hook('UserPromptSubmit', { prompt: 'x' })), new Date())).toBeNull();
  });
});

describe('질문·계획 승인 대기', () => {
  it('AskUserQuestion: 질문하면 나를 기다림, 답하면 다시 running, 기다리는 동안 stale 이 되지 않는다', () => {
    const asking = run(
      hook('UserPromptSubmit', { prompt: 'DB 설계해줘' }),
      hook('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: '어느 DB?' }] } }),
    );
    expect(v(asking)).toMatchObject({ status: 'waiting_for_you', waitingReason: 'question', currentActivity: 'AskUserQuestion: 어느 DB?' });
    expect(markStale(asking, new Date(Date.parse(asking.lastEventAt) + 60 * 60_000))).toBeNull();

    const answered = step(asking, hook('PostToolUse', { tool_name: 'AskUserQuestion' })).session;
    expect(answered.status).toBe('running');
    expect(answered.waitingReason).toBeUndefined();
  });

  it('ExitPlanMode: 계획 승인 대기 → 거절(실패)해도 다시 running', () => {
    const planning = run(hook('UserPromptSubmit', { prompt: 'x' }), hook('PreToolUse', { tool_name: 'ExitPlanMode', tool_input: { plan: 'p' } }));
    expect(v(planning)).toMatchObject({ status: 'waiting_for_you', waitingReason: 'plan' });
    expect(step(planning, hook('PostToolUseFailure', { tool_name: 'ExitPlanMode' })).session.status).toBe('running');
  });
});
