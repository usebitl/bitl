import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentEvent, normalizeAntigravity, normalizeCodexNotify, normalizeHook, normalizeReport, parseQuestions, questionsOf } from '../src/index.js';
import { describeDumpRecords } from './dump-records.js';

const AT = '2026-09-26T00:00:00.000Z';
const common = { session_id: 's1', cwd: 'C:/work/api', transcript_path: 'C:/t.jsonl', prompt_id: 'p1' };

describe('normalizeHook', () => {
  it('UserPromptSubmit → prompt', () => {
    const e = normalizeHook('claude-code', { ...common, hook_event_name: 'UserPromptSubmit', user_prompt: '로그인 고쳐줘' }, AT);
    expect(e).toMatchObject({ type: 'prompt', text: '로그인 고쳐줘', turnId: 'p1', cwd: 'C:/work/api' });
  });

  it('also reads the legacy prompt field', () => {
    const e = normalizeHook('codex', { ...common, hook_event_name: 'UserPromptSubmit', prompt: 'hi', turn_id: 't9' }, AT);
    expect(e).toMatchObject({ type: 'prompt', text: 'hi', turnId: 't9' });
  });

  it('PreToolUse → tool_start with a one-line summary', () => {
    const e = normalizeHook(
      'claude-code',
      { ...common, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'u1', tool_input: { command: 'pnpm\n  test' } },
      AT,
    );
    expect(e?.type).toBe('tool_start');
    expect(e?.tool).toEqual({ name: 'Bash', useId: 'u1', summary: 'pnpm test' });
  });

  it('PostToolUseFailure → failed tool_end', () => {
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

  it('subagent events carry agentId', () => {
    const e = normalizeHook(
      'claude-code',
      { ...common, hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore', task_description: 'find x' },
      AT,
    );
    expect(e).toMatchObject({ type: 'subagent_start', agentId: 'a1', agentType: 'Explore', text: 'find x' });
  });

  it('unknown events become notice, missing required fields give null', () => {
    expect(normalizeHook('claude-code', { ...common, hook_event_name: 'PreCompact' }, AT)?.type).toBe('notice');
    expect(normalizeHook('claude-code', { hook_event_name: 'Stop' }, AT)).toBeNull();
    expect(normalizeHook('claude-code', { session_id: 's1' }, AT)).toBeNull();
  });

  it('result passes the schema', () => {
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

// Anonymized samples made with make-sample.mjs (committed). Catches regressions from agent CLI format changes.
describeDumpRecords('sample fixtures (test/fixtures/*-sample.jsonl)', join(import.meta.dirname, 'fixtures'));

describe('Codex tool input', () => {
  it('summarizes an argv-array command on one line', () => {
    const at = '2026-09-26T00:00:00.000Z';
    const shell = normalizeHook('codex', { session_id: 'c', hook_event_name: 'PreToolUse', tool_name: 'shell', tool_input: { command: ['bash', '-lc', 'pnpm test'] } }, at);
    expect(shell?.tool?.summary).toBe('pnpm test');
    const argv = normalizeHook('codex', { session_id: 'c', hook_event_name: 'PreToolUse', tool_name: 'shell', tool_input: { command: ['git', 'status'] } }, at);
    expect(argv?.tool?.summary).toBe('git status');
  });

  it('webrun (web search, weather) uses the query or location as the summary', () => {
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

  it('start uses title as text, others use detail', () => {
    expect(normalizeReport('manual', { session_id: 'm', event: 'start', title: '배포 확인' }, at)?.text).toBe('배포 확인');
    expect(normalizeReport('manual', { session_id: 'm', event: 'done', title: 'x', detail: '끝' }, at)?.text).toBe('끝');
    expect(normalizeReport('manual', { session_id: 'm', event: 'waiting' }, at)?.waitingReason).toBe('input');
  });

  it('null for unknown event or missing session_id', () => {
    expect(normalizeReport('manual', { session_id: 'm', event: 'bogus' }, at)).toBeNull();
    expect(normalizeReport('manual', { event: 'start' }, at)).toBeNull();
  });
});

describe('tools that wait for a user reply', () => {
  const at = '2026-09-26T00:00:00.000Z';
  it('AskUserQuestion start → waiting(question), first question as summary', () => {
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
    expect(parseQuestions(e?.text)).toEqual([{ question: '어느 DB 를 쓸까요?', options: [{ label: 'SQLite' }] }]);
  });

  it('questionsOf keeps headers, multi-select and option descriptions, and drops empty entries', () => {
    const qs = questionsOf({
      questions: [
        { header: 'DB', question: '어느 DB?', multiSelect: true, options: [{ label: 'A', description: '빠름' }, { label: '' }] },
        { question: '' },
      ],
    });
    expect(qs).toEqual([{ header: 'DB', question: '어느 DB?', multiSelect: true, options: [{ label: 'A', description: '빠름' }] }]);
    expect(questionsOf({})).toBeUndefined();
    expect(parseQuestions('[{"question":"cut')).toBeUndefined();
  });

  it('ExitPlanMode start → waiting(plan)', () => {
    const e = normalizeHook('claude-code', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: { plan: '1. 스키마\n2. API' } }, at);
    expect(e).toMatchObject({ type: 'waiting', waitingReason: 'plan', tool: { summary: '1. 스키마 2. API' } });
  });

  it('the ending side (PostToolUse) is a plain tool_end', () => {
    const e = normalizeHook('claude-code', { session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion' }, at);
    expect(e?.type).toBe('tool_end');
  });
});

describe('normalizeReport request', () => {
  it('moves the user request summary into request', () => {
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

  it('only the first model call becomes the prompt; later calls and PostInvocation are dropped', () => {
    const prompt = run('PreInvocation', { invocationNum: 0, initialNumSteps: 1, prompt: '날씨 알려줘' });
    expect(prompt).toMatchObject({ source: 'antigravity', sessionId: 'conv-1', type: 'prompt', text: '날씨 알려줘', cwd: 'C:/playground' });
    expect(run('PreInvocation', { invocationNum: 1 })).toBeNull();
    expect(run('PostInvocation', { invocationNum: 0 })).toBeNull();
  });

  it('tools: CommandLine or query as summary, dropped without toolCall', () => {
    const cmd = { name: 'run_command', args: { CommandLine: 'Get-ChildItem', Cwd: 'C:\playground', toolSummary: 'List current directory' } };
    expect(run('PreToolUse', { toolCall: cmd })).toMatchObject({ type: 'tool_start', tool: { name: 'run_command', summary: 'Get-ChildItem' } });
    expect(run('PostToolUse', { toolCall: cmd, error: '' })?.tool?.failed).toBeUndefined();
    expect(run('PostToolUse', { toolCall: cmd, error: 'denied' })).toMatchObject({ type: 'tool_end', tool: { failed: true }, text: 'denied' });
    const search = { name: 'search_web', args: { query: '고양시 날씨', toolSummary: 'Search Goyang weather' } };
    expect(run('PreToolUse', { toolCall: search })?.tool?.summary).toBe('고양시 날씨');
    expect(run('PostToolUse', { toolCall: null })).toBeNull();
  });

  it('Stop is turn end, or error if there is one', () => {
    expect(run('Stop', { fullyIdle: true, terminationReason: 'NO_TOOL_CALL', error: '', last_assistant_message: '끝' })).toMatchObject({ type: 'turn_end', text: '끝' });
    expect(run('Stop', { error: 'quota exceeded' })).toMatchObject({ type: 'error', text: 'quota exceeded' });
  });

  it('approval waiting/resolved events from the watcher process', () => {
    const cmd = { name: 'run_command', args: { CommandLine: 'New-Item test6.txt' } };
    expect(run('bitl:PermissionWaiting', { toolCall: cmd, stepIdx: 2 })).toMatchObject({
      type: 'waiting',
      waitingReason: 'permission',
      tool: { name: 'run_command', summary: 'New-Item test6.txt' },
    });
    expect(run('bitl:PermissionResolved', { toolCall: cmd })).toMatchObject({ type: 'progress' });
  });

  it('null without an event name or conversation id', () => {
    expect(normalizeAntigravity({ ...base }, at)).toBeNull();
    expect(normalizeAntigravity({ hook_event_name: 'Stop' }, at)).toBeNull();
  });
});
