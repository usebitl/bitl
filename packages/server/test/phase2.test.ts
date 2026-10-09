import { seal, type StoredSession, type StoredTimelineItem, type StoredTurn } from '@bitl/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { LOCAL_ACCOUNT as A, openSqliteStore, type SessionStore } from '../src/store/index.js';
import { keys, view, viewTimeline, viewTurns, wire } from './helpers.js';

let store: SessionStore;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  store = openSqliteStore(':memory:');
  app = createApp({ store });
});
afterEach(() => store.close());

const json = (method: string, path: string, body?: unknown) =>
  app.request(path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' } });

const send = async (source: string, payload: Record<string, unknown>, receivedAt?: string) =>
  json('POST', '/api/events', await wire({ source, receivedAt, payload }));

const hook = (event: string, extra: Record<string, unknown>, receivedAt: string) =>
  send('claude-code', { session_id: 's1', hook_event_name: event, ...extra }, receivedAt);

const session = async (key: string) => view(await store.getSession(A, key));

describe('상태 보고 (MCP · 수동 작업)', () => {
  it('start → running, waiting → 나를 기다림, done → 검토 필요, end → 종료', async () => {
    const report = (event: string, extra: Record<string, unknown> = {}) => send('manual', { session_id: 'm1', event, ...extra });
    const status = async () => (await store.getSession(A, 'manual:m1'))?.status;

    await report('start', { title: '스테이징 배포 확인' });
    expect(await session('manual:m1')).toMatchObject({ status: 'running', title: '스테이징 배포 확인' });
    await report('progress', { detail: 'QA 체크리스트 3/10' });
    expect((await session('manual:m1'))?.currentActivity).toBe('QA 체크리스트 3/10');
    await report('waiting', { detail: '승인자 답변 대기' });
    expect(await session('manual:m1')).toMatchObject({ status: 'waiting_for_you', currentActivity: '승인자 답변 대기' });
    await report('done', { detail: '배포 완료' });
    expect(await session('manual:m1')).toMatchObject({ status: 'needs_review', lastMessage: '배포 완료' });
    await report('end');
    expect(await status()).toBe('ended');
  });

  it('Claude Desktop MCP 보고도 같은 형식', async () => {
    await send('claude-desktop', { session_id: 'd1', event: 'start', title: '회의록 정리' });
    expect((await store.getSession(A, 'claude-desktop:d1'))?.status).toBe('running');
  });
});

describe('PATCH /api/sessions/:key', () => {
  it('메모(암호문)와 핀만 바꾼다', async () => {
    await hook('SessionStart', {}, '2026-09-26T00:00:00Z');
    const note = await seal(keys, '리뷰 후 머지', 'claude-code:s1');
    const res = await json('PATCH', '/api/sessions/claude-code:s1', { note, pinned: true, status: 'ended' });
    const s = await view((await res.json()) as StoredSession);
    expect(s).toMatchObject({ note: '리뷰 후 머지', pinned: true, status: 'idle' });

    const cleared = await view((await (await json('PATCH', '/api/sessions/claude-code:s1', { note: '' })).json()) as StoredSession);
    expect(cleared?.note).toBeUndefined();
    expect(cleared?.pinned).toBe(true);
  });

  it('평문 메모는 400, 없는 세션은 404, 깨진 본문은 400', async () => {
    await hook('SessionStart', {}, '2026-09-26T00:00:00Z');
    expect((await json('PATCH', '/api/sessions/claude-code:s1', { note: '평문 메모' })).status).toBe(400);
    expect((await store.getSession(A, 'claude-code:s1'))?.enc.note).toBeUndefined();
    const note = await seal(keys, 'x', 'nope');
    expect((await json('PATCH', '/api/sessions/nope', { note })).status).toBe(404);
    expect((await app.request('/api/sessions/nope', { method: 'PATCH', body: '{' })).status).toBe(400);
  });
});

describe('세션 상세 타임라인', () => {
  it('최신순, notice 와 성공한 tool_end 는 제외, 실패한 도구는 포함', async () => {
    await hook('UserPromptSubmit', { prompt: '테스트 고쳐줘' }, '2026-09-26T00:00:01Z');
    await hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'pnpm test' } }, '2026-09-26T00:00:02Z');
    await hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'pnpm test' } }, '2026-09-26T00:00:03Z');
    await hook('PostToolUseFailure', { tool_name: 'Edit', tool_input: { file_path: 'a.ts' }, error_message: 'no match' }, '2026-09-26T00:00:04Z');
    await hook('PreCompact', {}, '2026-09-26T00:00:05Z');
    await hook('Stop', { last_assistant_message: '완료' }, '2026-09-26T00:00:06Z');

    const { timeline } = (await (await app.request('/api/sessions/claude-code:s1')).json()) as { timeline: StoredTimelineItem[] };
    expect(timeline.map((t) => t.nativeType)).toEqual(['Stop', 'PostToolUseFailure', 'PreToolUse', 'UserPromptSubmit']);
    const items = await viewTimeline('claude-code:s1', timeline);
    expect(items[1]).toMatchObject({ tool: { name: 'Edit', summary: 'a.ts', failed: true }, text: 'no match' });
    expect(items[2]).toMatchObject({ tool: { name: 'Bash', summary: 'pnpm test' } });
    expect(JSON.stringify(timeline)).not.toContain('pnpm');
  });
});

describe('pruneEvents', () => {
  it('기준보다 오래된 원본 이벤트만 지우고 세션은 남긴다', async () => {
    await hook('UserPromptSubmit', { prompt: 'old' }, '2026-09-01T00:00:00Z');
    await hook('Stop', {}, '2026-09-20T00:00:00Z');
    expect(await store.pruneEvents(new Date('2026-09-10T00:00:00Z'))).toBe(1);
    expect((await store.listTimeline(A, 'claude-code:s1'))).toHaveLength(1);
    expect((await session('claude-code:s1'))?.title).toBe('old');
  });
});

describe('Claude Desktop 대화 따라가기 (카드가 생긴 대화는 응답마다 보고)', () => {
  const report = (payload: Record<string, unknown>, receivedAt: string) => send('claude-desktop', { session_id: 'd1', ...payload }, receivedAt);
  const turns = async () =>
    viewTurns(((await (await app.request('/api/sessions/claude-desktop:d1')).json()) as { turns: StoredTurn[] }).turns);

  it('요청마다 턴이 쌓이고, 질문으로 끝나면 나를 기다림, 답을 마치면 검토 필요', async () => {
    await report({ event: 'start', title: '회의 안건 정리', request: '회의 안건 3개 뽑아줘' }, '2026-09-26T00:00:00Z');
    await report({ event: 'waiting', request: '회의 안건 3개 뽑아줘', detail: '어떤 회의인지 알려주세요' }, '2026-09-26T00:00:10Z');
    expect(await session('claude-desktop:d1')).toMatchObject({
      status: 'waiting_for_you',
      title: '회의 안건 정리',
      lastPrompt: '회의 안건 3개 뽑아줘',
      lastMessage: '어떤 회의인지 알려주세요',
      turnCount: 1,
    });

    // 사용자가 답함 → Claude 가 응답 끝에 done 보고 (새 request → 새 턴)
    await report({ event: 'done', request: '주간 제품 회의야', detail: '안건 3개: 출시 일정, QA, 회고' }, '2026-09-26T00:05:00Z');
    const s = (await session('claude-desktop:d1'))!;
    expect(s).toMatchObject({ status: 'needs_review', lastPrompt: '주간 제품 회의야', lastMessage: '안건 3개: 출시 일정, QA, 회고', turnCount: 2 });
    expect(s.statusAt).toBe('2026-09-26T00:05:00.000Z');

    // 같은 대화에서 또 질문 → 다시 검토 필요, 기준 시각 갱신
    await report({ event: 'done', request: '도구는 뭘 많이 써?', detail: '캘린더·드라이브·메일 역할 설명' }, '2026-09-26T00:09:00Z');
    expect((await store.getSession(A, 'claude-desktop:d1'))?.statusAt).toBe('2026-09-26T00:09:00.000Z');

    expect(await turns()).toEqual([
      expect.objectContaining({ prompt: '도구는 뭘 많이 써?', result: '캘린더·드라이브·메일 역할 설명', status: 'done' }),
      expect.objectContaining({ prompt: '주간 제품 회의야', result: '안건 3개: 출시 일정, QA, 회고', status: 'done' }),
      expect.objectContaining({ prompt: '회의 안건 3개 뽑아줘', result: '어떤 회의인지 알려주세요', status: 'done' }),
    ]);
  });

  it('request 없이 보내도 동작한다 (이전 방식 호환)', async () => {
    await report({ event: 'start', title: 't' }, '2026-09-26T00:00:00Z');
    await report({ event: 'done', detail: '끝' }, '2026-09-26T00:01:00Z');
    expect(await session('claude-desktop:d1')).toMatchObject({ status: 'needs_review', lastPrompt: 't', turnCount: 1 });
    expect(await turns()).toHaveLength(1);
  });
});

describe('DELETE /api/sessions/:key', () => {
  it('세션·턴·이벤트를 지우고 SSE 로 removed 를 보낸다', async () => {
    await hook('UserPromptSubmit', { prompt: '지울 작업' }, '2026-09-26T00:00:01Z');
    await hook('Stop', { last_assistant_message: '끝' }, '2026-09-26T00:00:02Z');

    const res = await app.request('/api/stream');
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const until = async (needle: string) => {
      while (!buf.includes(needle)) buf += dec.decode((await reader.read()).value);
    };
    await until('event: snapshot');

    expect((await json('DELETE', '/api/sessions/claude-code:s1')).status).toBe(200);
    await until('event: removed');
    expect(buf).toContain('data: {"key":"claude-code:s1"}');
    await reader.cancel();

    expect((await store.getSession(A, 'claude-code:s1'))).toBeUndefined();
    expect((await store.listTurns(A, 'claude-code:s1'))).toHaveLength(0);
    expect((await store.listTimeline(A, 'claude-code:s1'))).toHaveLength(0);
    expect((await json('DELETE', '/api/sessions/claude-code:s1')).status).toBe(404);
  });

  it('지운 뒤 에이전트가 계속 일하면 새 카드로 다시 나타난다', async () => {
    await hook('UserPromptSubmit', { prompt: 'a' }, '2026-09-26T00:00:01Z');
    await json('DELETE', '/api/sessions/claude-code:s1');
    await hook('UserPromptSubmit', { prompt: '다음 지시' }, '2026-09-26T00:01:00Z');
    expect(await session('claude-code:s1')).toMatchObject({ status: 'running', title: '다음 지시', turnCount: 1 });
  });
});
