import { describe, expect, it } from 'vitest';
import { deriveKeys, generateMasterKey, open, sealerFor } from '../src/crypto.js';
import { normalizeHook, normalizeRecord, normalizeReport } from '../src/normalize.js';
import { prepareRecord, splitEvent, TEXT_LIMIT } from '../src/prepare.js';
import { parseWireRecord } from '../src/wire.js';

const AT = '2026-09-27T00:00:00.000Z';
const hook = (name: string, extra: Record<string, unknown> = {}) =>
  normalizeHook('claude-code', { session_id: 's1', cwd: 'C:/work/secret-project', hook_event_name: name, ...extra }, AT)!;

describe('splitEvent — 최소화', () => {
  it('도구 입력 전체와 도구 결과는 보내지 않는다 (이름과 한 줄 요약만)', () => {
    const code = 'export const password = "hunter2";';
    const { signal, content } = splitEvent(
      hook('PostToolUse', {
        tool_name: 'Edit',
        tool_input: { file_path: 'src/config.ts', old_string: 'x', new_string: code },
        tool_response: { filePath: 'src/config.ts', originalFile: code.repeat(50) },
      }),
    );
    const all = JSON.stringify({ signal, content });
    expect(all).not.toContain('hunter2');
    expect(all).not.toContain('tool_response');
    expect(content).toEqual({ activity: 'Edit: src/config.ts', tool: 'Edit', toolSummary: 'src/config.ts' });
  });

  it('프롬프트·응답은 앞부분만, 제목은 한 줄', () => {
    const long = `첫 줄\n${'가'.repeat(TEXT_LIMIT + 2000)}`;
    const { content } = splitEvent(hook('UserPromptSubmit', { prompt: long }));
    expect(content.text!.length).toBe(TEXT_LIMIT);
    expect(content.text!.endsWith('…')).toBe(true);
    expect(content.title!.length).toBeLessThanOrEqual(80);
    expect(content.title).not.toContain('\n');
  });

  it('작업 위치(cwd)는 세션 시작·지시·턴 종료에만 싣는다', () => {
    expect(splitEvent(hook('UserPromptSubmit', { prompt: 'x' })).content.cwd).toBe('C:/work/secret-project');
    expect(splitEvent(hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } })).content.cwd).toBeUndefined();
    expect(splitEvent(hook('CwdChanged', { new_cwd: 'C:/work/other' })).content.cwd).toBe('C:/work/other');
  });

  it('신호에는 상태 판단에 필요한 것만 (내용 없음)', () => {
    const { signal } = splitEvent(hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf dist' }, agent_id: 'a1', agent_type: 'Explore' }));
    expect(signal).toEqual({
      source: 'claude-code',
      sessionId: 's1',
      type: 'waiting',
      nativeType: 'PermissionRequest',
      at: AT,
      agentId: 'a1',
      agentNamed: true,
      waitingReason: 'permission',
    });
  });

  it('agent_type 이 빈 서브에이전트는 agentNamed=false', () => {
    expect(splitEvent(hook('SubagentStop', { agent_id: 'x', agent_type: '' })).signal.agentNamed).toBe(false);
    expect(splitEvent(hook('Stop')).signal.agentNamed).toBeUndefined();
  });

  it('상태 보고: 시작은 제목을, 이후는 request 를 태그 대상으로', () => {
    const start = normalizeReport('claude-desktop', { session_id: 'd1', event: 'start', title: '회의록', request: '요약해줘' }, AT)!;
    expect(splitEvent(start).tagSource).toBe('요약해줘');
    const noRequest = normalizeReport('manual', { session_id: 'm1', event: 'start', title: '배포 확인' }, AT)!;
    expect(splitEvent(noRequest).tagSource).toBe('배포 확인');
    const done = normalizeReport('claude-desktop', { session_id: 'd1', event: 'done', detail: '끝' }, AT)!;
    expect(splitEvent(done).tagSource).toBeUndefined();
  });
});

describe('prepareRecord — 봉인', () => {
  it('내용은 모두 암호문, 신호는 평문, 서버 검증을 통과한다', async () => {
    const keys = await deriveKeys(generateMasterKey());
    const e = hook('UserPromptSubmit', { prompt: '로그인 버그 고쳐줘', prompt_id: 'p1' });
    const rec = await prepareRecord(e, sealerFor(keys), { project: 'secret-project', gitBranch: 'main' });

    const json = JSON.stringify(rec);
    for (const secret of ['로그인', 'secret-project', 'C:/work', 'main"']) expect(json).not.toContain(secret);
    expect(rec.signal).toMatchObject({ type: 'prompt', turnId: 'p1' });
    expect(rec.signal.requestTag).toMatch(/^[\w-]{22}$/);
    expect(await open(keys, rec.content.text!, 'claude-code:s1')).toBe('로그인 버그 고쳐줘');
    expect(await open(keys, rec.content.project!, 'claude-code:s1')).toBe('secret-project');
    expect(parseWireRecord(JSON.parse(json))).not.toBeNull();
  });

  it('서버 검증은 평문 내용·옛 형식을 거부한다', () => {
    const signal = { source: 'claude-code', sessionId: 's1', type: 'prompt', nativeType: 'UserPromptSubmit', at: AT };
    expect(parseWireRecord({ v: 2, signal, content: { text: '평문 프롬프트' } })).toBeNull();
    expect(parseWireRecord({ v: 2, signal, content: {} })).not.toBeNull();
    expect(parseWireRecord({ source: 'claude-code', payload: { session_id: 's1', hook_event_name: 'Stop' } })).toBeNull();
  });
});

describe('normalizeRecord', () => {
  it('source 로 형식을 고르고 시각을 UTC 로', () => {
    expect(normalizeRecord({ source: 'codex-notify', payload: { type: 'agent-turn-complete', 'thread-id': 't1' } })?.source).toBe('codex');
    expect(normalizeRecord({ source: 'manual', payload: { session_id: 'm', event: 'start', title: 't' } })?.nativeType).toBe('report:start');
    expect(normalizeRecord({ source: 'claude-code', receivedAt: '2026-09-27T09:00:00+09:00', payload: { session_id: 's', hook_event_name: 'Stop' } })?.at).toBe(
      '2026-09-27T00:00:00.000Z',
    );
    expect(normalizeRecord({ source: 'nope', payload: {} })).toBeNull();
  });
});
