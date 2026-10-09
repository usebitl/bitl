import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentEvent, normalizeAntigravity, normalizeCodexNotify, normalizeHook, normalizeReport } from '../src/index.js';
import { describeDumpRecords } from './dump-records.js';

const AT = '2026-09-26T00:00:00.000Z';
const common = { session_id: 's1', cwd: 'C:/work/api', transcript_path: 'C:/t.jsonl', prompt_id: 'p1' };

describe('normalizeHook', () => {
  it('UserPromptSubmit → prompt', () => {
    const e = normalizeHook('claude-code', { ...common, hook_event_name: 'UserPromptSubmit', user_prompt: '로그인 고쳐줘' }, AT);
    expect(e).toMatchObject({ type: 'prompt', text: '로그인 고쳐줘', turnId: 'p1', cwd: 'C:/work/api' });
  });

  it('구버전 prompt 필드도 읽는다', () => {
    const e = normalizeHook('codex', { ...common, hook_event_name: 'UserPromptSubmit', prompt: 'hi', turn_id: 't9' }, AT);
    expect(e).toMatchObject({ type: 'prompt', text: 'hi', turnId: 't9' });
  });

  it('PreToolUse → tool_start 와 한 줄 요약', () => {
    const e = normalizeHook(
      'claude-code',
      { ...common, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'u1', tool_input: { command: 'pnpm\n  test' } },
      AT,
    );
    expect(e?.type).toBe('tool_start');
    expect(e?.tool).toEqual({ name: 'Bash', useId: 'u1', summary: 'pnpm test' });
  });

  it('PostToolUseFailure → 실패한 tool_end', () => {
    const e = normalizeHook(
      'claude-code',
      { ...common, hook_event_name: 'PostToolUseFailure', tool_name: 'Edit', tool_input: { file_path: 'a.ts' }, error_message: 'boom' },
      AT,
    );
    expect(e).toMatchObject({ type: 'tool_end', tool: { name: 'Edit', summary: 'a.ts', failed: true }, text: 'boom' });
  });

  it.each([
    ['permission_prompt', 'waiting', 'permission'],
    ['idle_prompt', 'waiting', 'idle'],
    ['elicitation_dialog', 'waiting', 'elicitation'],
    ['agent_needs_input', 'waiting', 'input'],
    ['auth_success', 'notice', undefined],
  ])('Notification(%s) → %s', (kind, type, reason) => {
    const e = normalizeHook('claude-code', { ...common, hook_event_name: 'Notification', notification_type: kind }, AT);
    expect(e?.type).toBe(type);
    expect(e?.waitingReason).toBe(reason);
  });

  it('PermissionRequest → waiting(permission)', () => {
    const e = normalizeHook('codex', { ...common, hook_event_name: 'PermissionRequest', tool_name: 'shell', tool_input: { command: 'rm -rf dist' } }, AT);
    expect(e).toMatchObject({ type: 'waiting', waitingReason: 'permission', tool: { summary: 'rm -rf dist' } });
  });

  it('Stop / Interrupt → turn_end', () => {
    expect(normalizeHook('claude-code', { ...common, hook_event_name: 'Stop', last_assistant_message: '완료' }, AT)).toMatchObject({
      type: 'turn_end',
      text: '완료',
    });
    expect(normalizeHook('codex', { ...common, hook_event_name: 'Interrupt' }, AT)?.type).toBe('turn_end');
  });

  it('StopFailure → error', () => {
    const e = normalizeHook('claude-code', { ...common, hook_event_name: 'StopFailure', error_type: 'rate_limit' }, AT);
    expect(e).toMatchObject({ type: 'error', text: 'rate_limit' });
  });

  it('서브에이전트 이벤트는 agentId 를 가진다', () => {
    const e = normalizeHook(
      'claude-code',
      { ...common, hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore', task_description: 'find x' },
      AT,
    );
    expect(e).toMatchObject({ type: 'subagent_start', agentId: 'a1', agentType: 'Explore', text: 'find x' });
  });

  it('모르는 이벤트는 notice, 필수값 없으면 null', () => {
    expect(normalizeHook('claude-code', { ...common, hook_event_name: 'PreCompact' }, AT)?.type).toBe('notice');
    expect(normalizeHook('claude-code', { hook_event_name: 'Stop' }, AT)).toBeNull();
    expect(normalizeHook('claude-code', { session_id: 's1' }, AT)).toBeNull();
  });

  it('결과는 스키마를 통과한다', () => {
    const e = normalizeHook('claude-code', { ...common, hook_event_name: 'SessionStart', model: 'claude-opus-5-5' }, AT);
    expect(AgentEvent.parse(e)).toBeTruthy();
  });
});

describe('normalizeCodexNotify', () => {
  it('agent-turn-complete → turn_end', () => {
    const e = normalizeCodexNotify(
      { type: 'agent-turn-complete', 'thread-id': 't1', 'turn-id': 'u1', cwd: 'C:/x', 'input-messages': ['a'], 'last-assistant-message': 'done' },
      AT,
    );
    expect(e).toMatchObject({ source: 'codex', sessionId: 't1', type: 'turn_end', turnId: 'u1', text: 'done' });
    expect(AgentEvent.parse(e)).toBeTruthy();
  });
});

// make-sample.mjs 로 만든 익명화 샘플 (커밋됨). 에이전트 CLI 포맷 변경 회귀 감지용.
describeDumpRecords('샘플 fixtures (test/fixtures/*-sample.jsonl)', join(import.meta.dirname, 'fixtures'));

describe('Codex 도구 입력', () => {
  it('argv 배열 command 를 한 줄로 요약한다', () => {
    const at = '2026-09-26T00:00:00.000Z';
    const shell = normalizeHook('codex', { session_id: 'c', hook_event_name: 'PreToolUse', tool_name: 'shell', tool_input: { command: ['bash', '-lc', 'pnpm test'] } }, at);
    expect(shell?.tool?.summary).toBe('pnpm test');
    const argv = normalizeHook('codex', { session_id: 'c', hook_event_name: 'PreToolUse', tool_name: 'shell', tool_input: { command: ['git', 'status'] } }, at);
    expect(argv?.tool?.summary).toBe('git status');
  });

  it('webrun(웹 검색·날씨) 은 검색어·지역을 요약으로', () => {
    const at = '2026-10-03T00:00:00.000Z';
    const run = (tool_input: unknown) =>
      normalizeHook('codex', { session_id: 'c', hook_event_name: 'PreToolUse', tool_name: 'webrun', tool_input }, at)?.tool?.summary;
    expect(run({ search_query: [{ q: '서울 오늘 날씨' }], response_length: 'short' })).toBe('서울 오늘 날씨');
    expect(run({ weather: [{ location: 'Seoul, South Korea' }], response_length: 'short' })).toBe('Seoul, South Korea');
  });
});

describe('normalizeReport', () => {
  const at = '2026-09-26T00:00:00.000Z';
  it.each([
    ['start', 'prompt'],
    ['progress', 'progress'],
    ['waiting', 'waiting'],
    ['done', 'turn_end'],
    ['error', 'error'],
    ['end', 'session_end'],
  ])('%s → %s', (event, type) => {
    const e = normalizeReport('claude-desktop', { session_id: 'd1', event, title: '보고서 작성', detail: '2/5 섹션' }, at);
    expect(e?.type).toBe(type);
    expect(AgentEvent.parse(e)).toBeTruthy();
  });

  it('start 는 제목을, 나머지는 detail 을 text 로', () => {
    expect(normalizeReport('manual', { session_id: 'm', event: 'start', title: '배포 확인' }, at)?.text).toBe('배포 확인');
    expect(normalizeReport('manual', { session_id: 'm', event: 'done', title: 'x', detail: '끝' }, at)?.text).toBe('끝');
    expect(normalizeReport('manual', { session_id: 'm', event: 'waiting' }, at)?.waitingReason).toBe('input');
  });

  it('모르는 event 나 session_id 없으면 null', () => {
    expect(normalizeReport('manual', { session_id: 'm', event: 'bogus' }, at)).toBeNull();
    expect(normalizeReport('manual', { event: 'start' }, at)).toBeNull();
  });
});

describe('사용자 응답을 기다리는 도구', () => {
  const at = '2026-09-26T00:00:00.000Z';
  it('AskUserQuestion 시작 → waiting(question), 첫 질문을 요약', () => {
    const e = normalizeHook(
      'claude-code',
      {
        session_id: 's',
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: '어느 DB 를 쓸까요?', options: [{ label: 'SQLite' }] }] },
      },
      at,
    );
    expect(e).toMatchObject({ type: 'waiting', waitingReason: 'question', tool: { name: 'AskUserQuestion', summary: '어느 DB 를 쓸까요?' } });
  });

  it('ExitPlanMode 시작 → waiting(plan)', () => {
    const e = normalizeHook('claude-code', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: { plan: '1. 스키마\n2. API' } }, at);
    expect(e).toMatchObject({ type: 'waiting', waitingReason: 'plan', tool: { summary: '1. 스키마 2. API' } });
  });

  it('끝나는 쪽(PostToolUse)은 일반 tool_end', () => {
    const e = normalizeHook('claude-code', { session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion' }, at);
    expect(e?.type).toBe('tool_end');
  });
});

describe('normalizeReport request', () => {
  it('사용자 요청 요약을 request 로 옮긴다', () => {
    const e = normalizeReport('claude-desktop', { session_id: 'd', event: 'done', request: '안건 뽑아줘', detail: '3개 뽑음' }, '2026-09-26T00:00:00.000Z');
    expect(e).toMatchObject({ type: 'turn_end', request: '안건 뽑아줘', text: '3개 뽑음' });
    expect(AgentEvent.parse(e)).toBeTruthy();
  });
});

describe('normalizeAntigravity', () => {
  const at = '2026-10-03T06:50:00.000Z';
  const base = {
    conversationId: 'conv-1',
    workspacePaths: ['C:/playground'],
    modelName: 'gemini-3.8-flash-high',
    transcriptPath: 'C:/x/transcript_full.jsonl',
  };
  const run = (event: string, extra: Record<string, unknown> = {}) => normalizeAntigravity({ ...base, hook_event_name: event, ...extra }, at);

  it('첫 모델 호출만 질문으로, 이어지는 호출·PostInvocation 은 버린다', () => {
    const prompt = run('PreInvocation', { invocationNum: 0, initialNumSteps: 1, prompt: '날씨 알려줘' });
    expect(prompt).toMatchObject({ source: 'antigravity', sessionId: 'conv-1', type: 'prompt', text: '날씨 알려줘', cwd: 'C:/playground' });
    expect(run('PreInvocation', { invocationNum: 1 })).toBeNull();
    expect(run('PostInvocation', { invocationNum: 0 })).toBeNull();
  });

  it('도구: CommandLine·query 를 요약으로, toolCall 이 없으면 버린다', () => {
    const cmd = { name: 'run_command', args: { CommandLine: 'Get-ChildItem', Cwd: 'C:\playground', toolSummary: 'List current directory' } };
    expect(run('PreToolUse', { toolCall: cmd })).toMatchObject({ type: 'tool_start', tool: { name: 'run_command', summary: 'Get-ChildItem' } });
    expect(run('PostToolUse', { toolCall: cmd, error: '' })?.tool?.failed).toBeUndefined();
    expect(run('PostToolUse', { toolCall: cmd, error: 'denied' })).toMatchObject({ type: 'tool_end', tool: { failed: true }, text: 'denied' });
    const search = { name: 'search_web', args: { query: '고양시 날씨', toolSummary: 'Search Goyang weather' } };
    expect(run('PreToolUse', { toolCall: search })?.tool?.summary).toBe('고양시 날씨');
    expect(run('PostToolUse', { toolCall: null })).toBeNull();
  });

  it('Stop 은 턴 끝, 오류가 있으면 오류', () => {
    expect(run('Stop', { fullyIdle: true, terminationReason: 'NO_TOOL_CALL', error: '', last_assistant_message: '끝' })).toMatchObject({ type: 'turn_end', text: '끝' });
    expect(run('Stop', { error: 'quota exceeded' })).toMatchObject({ type: 'error', text: 'quota exceeded' });
  });

  it('감시 프로세스가 만든 승인 대기·해제', () => {
    const cmd = { name: 'run_command', args: { CommandLine: 'New-Item test6.txt' } };
    expect(run('bitl:PermissionWaiting', { toolCall: cmd, stepIdx: 2 })).toMatchObject({
      type: 'waiting',
      waitingReason: 'permission',
      tool: { name: 'run_command', summary: 'New-Item test6.txt' },
    });
    expect(run('bitl:PermissionResolved', { toolCall: cmd })).toMatchObject({ type: 'progress' });
  });

  it('이벤트 이름이나 대화 id 가 없으면 null', () => {
    expect(normalizeAntigravity({ ...base }, at)).toBeNull();
    expect(normalizeAntigravity({ hook_event_name: 'Stop' }, at)).toBeNull();
  });
});
