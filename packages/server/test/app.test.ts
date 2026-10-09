import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { StoredSession, StoredTurn } from '@bitl/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { drainQueue } from '../src/index.js';
import { LOCAL_ACCOUNT as A, openSqliteStore, type SessionStore } from '../src/store/index.js';
import { keys, view, viewTurns, wire } from './helpers.js';

let store: SessionStore;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  store = openSqliteStore(':memory:');
  app = createApp({ store });
});
afterEach(() => store.close());

const postJson = (body: unknown) =>
  app.request('/api/events', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

type Rec = { source: string; receivedAt?: string; payload: Record<string, unknown> };
/** 어댑터처럼 봉인해서 보낸다 */
const post = async (rec: Rec) => postJson(await wire(rec));

const rec = (event: string, extra: Record<string, unknown> = {}, receivedAt = new Date().toISOString()): Rec => ({
  source: 'claude-code',
  receivedAt,
  payload: { session_id: 's1', cwd: 'C:/work/api', hook_event_name: event, ...extra },
});

describe('POST /api/events', () => {
  it('봉인된 레코드 { v, signal, content } 를 받는다', async () => {
    const res = await post(rec('UserPromptSubmit', { prompt: '안녕' }));
    expect(await res.json()).toEqual({ ok: true, accepted: true, key: 'claude-code:s1' });
    expect((await store.getSession(A, 'claude-code:s1'))?.status).toBe('running');
    expect((await view((await store.getSession(A, 'claude-code:s1'))))?.title).toBe('안녕');
  });

  it('Codex notify', async () => {
    await post({ source: 'codex-notify', payload: { type: 'agent-turn-complete', 'thread-id': 't1', cwd: 'C:/x' } });
    expect((await store.getSession(A, 'codex:t1'))?.status).toBe('needs_review');
  });

  it('시각은 UTC ISO 8601 로 정규화해 저장한다', async () => {
    await post(rec('UserPromptSubmit', { prompt: 'x' }, '2026-09-26T08:00:00+09:00'));
    expect((await store.getSession(A, 'claude-code:s1'))?.startedAt).toBe('2026-09-25T23:00:00.000Z');
    expect((await store.listTurns(A, 'claude-code:s1'))[0]?.startedAt).toBe('2026-09-25T23:00:00.000Z');
  });

  it('옛 형식(원본 페이로드)·평문 내용·모르는 형식은 200 으로 받되 accepted=false — 저장하지 않는다', async () => {
    const plain = await wire(rec('UserPromptSubmit', { prompt: '비밀' }));
    const bodies = [
      rec('UserPromptSubmit', { prompt: '비밀' }), // 옛 어댑터
      { session_id: 's1', hook_event_name: 'Stop' }, // http hook 원본
      { ...plain, content: { ...plain.content, text: '평문 프롬프트' } },
      { foo: 1 },
    ];
    for (const body of bodies) {
      const res = await postJson(body);
      expect(res.status).toBe(200);
      expect((await res.json()).accepted).toBe(false);
    }
    expect(await store.listSessions(A, { includeEnded: true })).toHaveLength(0);
  });

  it('깨진 JSON 은 400', async () => {
    const res = await app.request('/api/events', { method: 'POST', body: '{', headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(400);
  });
});

describe('서버에는 평문이 남지 않는다', () => {
  it('프롬프트·명령·경로·응답이 DB 파일에 없다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bitl-db-'));
    const file = join(dir, 'bitl.db');
    const diskStore = openSqliteStore(file);
    const diskApp = createApp({ store: diskStore });
    const send = async (r: Rec) =>
      diskApp.request('/api/events', { method: 'POST', body: JSON.stringify(await wire(r)), headers: { 'content-type': 'application/json' } });

    await send(rec('SessionStart', { cwd: 'C:/work/SECRET-PROJECT' }));
    await send(rec('UserPromptSubmit', { prompt: 'SECRET-PROMPT 고쳐줘', cwd: 'C:/work/SECRET-PROJECT' }));
    await send(rec('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'deploy --token SECRET-COMMAND' } }));
    await send(rec('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'x' }, tool_response: { stdout: 'SECRET-OUTPUT' } }));
    await send(rec('Stop', { last_assistant_message: 'SECRET-ANSWER 완료', cwd: 'C:/work/SECRET-PROJECT' }));
    await diskStore.close();

    const db = new DatabaseSync(file);
    const dump = ['sessions', 'turns', 'events']
      .map((t) => JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all()))
      .join('\n');
    db.close();
    expect(dump).toContain('"status"'); // 신호는 있다
    expect(dump).not.toMatch(/SECRET/);
  });
});

describe('세션 API', () => {
  it('목록, 상세(턴 포함), 확인, 보관', async () => {
    await post(rec('UserPromptSubmit', { prompt: '첫 작업', prompt_id: 'p1' }, '2026-09-26T00:00:01Z'));
    await post(rec('PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'a.ts' }, prompt_id: 'p1' }, '2026-09-26T00:00:02Z'));
    await post(rec('Stop', { last_assistant_message: '끝', prompt_id: 'p1' }, '2026-09-26T00:00:03Z'));

    const list = (await (await app.request('/api/sessions')).json()) as StoredSession[];
    expect(list).toHaveLength(1);
    expect(await view(list[0])).toMatchObject({ status: 'needs_review', title: '첫 작업', toolCount: 1 });

    const detail = (await (await app.request('/api/sessions/claude-code:s1')).json()) as { turns: StoredTurn[] };
    expect(await viewTurns(detail.turns)).toEqual([
      expect.objectContaining({ prompt: '첫 작업', result: '끝', status: 'done', toolCount: 1, turnId: 'p1' }),
    ]);

    const acked = await (await app.request('/api/sessions/claude-code:s1/ack', { method: 'POST' })).json();
    expect(acked.status).toBe('idle');

    await app.request('/api/sessions/claude-code:s1/archive', { method: 'POST' });
    expect(await (await app.request('/api/sessions')).json()).toHaveLength(0);
    expect(await (await app.request('/api/sessions?archived=1')).json()).toHaveLength(1);
  });

  it('종료된 세션은 ?ended=1 일 때만', async () => {
    await post(rec('SessionStart'));
    await post(rec('SessionEnd', { reason: 'other' }));
    expect(await (await app.request('/api/sessions')).json()).toHaveLength(0);
    expect(await (await app.request('/api/sessions?ended=1')).json()).toHaveLength(1);
  });

  it('종료된 카드 일괄 삭제 — 종료된 것만, keys 를 주면 그중에서만', async () => {
    const at = (s: number) => `2026-09-26T00:00:0${s}Z`;
    const r = (sid: string, event: string, s: number) => ({ ...rec(event, {}, at(s)), payload: { ...rec(event).payload, session_id: sid } });
    for (const sid of ['e1', 'e2']) {
      await post(r(sid, 'SessionStart', 1));
      await post(r(sid, 'SessionEnd', 2));
    }
    await post(r('live', 'UserPromptSubmit', 3));
    const del = (body: unknown) =>
      app.request('/api/sessions/delete-ended', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

    expect(await (await del({ keys: ['claude-code:e1', 'claude-code:live'] })).json()).toEqual({ deleted: 1 });
    expect(await (await del({})).json()).toEqual({ deleted: 1 });
    const left = (await (await app.request('/api/sessions?ended=1')).json()) as StoredSession[];
    expect(left.map((s) => s.key)).toEqual(['claude-code:live']);
  });

  it('없는 세션은 404', async () => {
    expect((await app.request('/api/sessions/nope')).status).toBe(404);
  });
});

describe('SSE /api/stream', () => {
  it('연결하면 snapshot, 이후 바뀐 세션을 보낸다', async () => {
    await post(rec('SessionStart'));
    const res = await app.request('/api/stream');
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const until = async (needle: string) => {
      while (!buf.includes(needle)) buf += dec.decode((await reader.read()).value);
    };
    await until('event: snapshot');
    await post(rec('UserPromptSubmit', { prompt: '실시간' }));
    await until('"status":"running"');
    expect(buf).toMatch(/event: session\ndata: .*"status":"running"/);
    expect(buf).not.toContain('실시간');
    await reader.cancel();
  });
});

describe('queue.jsonl', () => {
  it('어댑터가 쌓아 둔 (봉인된) 이벤트를 시간순으로 처리하고, 옛 형식 줄은 버리고, 파일을 지운다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bitl-'));
    const lines = [
      JSON.stringify(await wire(rec('Stop', { last_assistant_message: 'done' }, '2026-09-26T00:00:02Z'))),
      JSON.stringify(await wire(rec('UserPromptSubmit', { prompt: 'offline' }, '2026-09-26T00:00:01Z'))),
      JSON.stringify(rec('UserPromptSubmit', { prompt: '옛 형식' }, '2026-09-26T00:00:03Z')),
      '{broken',
    ];
    writeFileSync(join(home, 'queue.jsonl'), lines.join('\n') + '\n');
    expect(await drainQueue(store, home)).toBe(2);
    expect(await view((await store.getSession(A, 'claude-code:s1')))).toMatchObject({ status: 'needs_review', title: 'offline' });
    expect(() => readFileSync(join(home, 'queue.jsonl'))).toThrow();
  });
});

describe('옛 형식 DB', () => {
  it('내용이 평문인 v1 DB 는 백업 파일로 옮기고 새로 시작한다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bitl-legacy-'));
    const file = join(dir, 'bitl.db');
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE sessions (key TEXT PRIMARY KEY, status TEXT, last_event_at TEXT, archived INTEGER, data TEXT);
      INSERT INTO sessions VALUES ('claude-code:old', 'idle', '2026-09-01T00:00:00.000Z', 0, '{"title":"평문 제목"}');`);
    old.close();

    const s = openSqliteStore(file);
    expect(s.backupPath).toBeDefined();
    expect(await s.listSessions(A, { includeEnded: true })).toHaveLength(0);
    await s.close();
    expect(readFileSync(s.backupPath!).length).toBeGreaterThan(0);

    const reopened = openSqliteStore(file); // 이미 새 형식이면 옮기지 않는다
    expect(reopened.backupPath).toBeUndefined();
    await reopened.close();
  });

  it('v2(Phase 3, 계정 없음) DB 는 기록을 그대로 로컬 계정으로 옮긴다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bitl-v2-'));
    const file = join(dir, 'bitl.db');
    // v2 스키마로 기록을 남긴다
    const v2 = new DatabaseSync(file);
    v2.exec(`
      CREATE TABLE sessions (key TEXT PRIMARY KEY, status TEXT NOT NULL, last_event_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL);
      CREATE INDEX sessions_last_event ON sessions(last_event_at);
      CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT, session_key TEXT NOT NULL, turn_id TEXT, prompt TEXT, result TEXT, status TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, tool_count INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX turns_session ON turns(session_key, started_at);
      CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_key TEXT NOT NULL, at TEXT NOT NULL, type TEXT NOT NULL, native_type TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX events_session ON events(session_key, at);
      PRAGMA user_version = 2;`);
    const recs = [
      await wire(rec('UserPromptSubmit', { prompt: '옮겨질 작업', prompt_id: 'p1' }, '2026-09-26T00:00:01Z')),
      await wire(rec('PostToolUseFailure', { tool_name: 'Edit', tool_input: { file_path: 'a.ts' }, error_message: 'x' }, '2026-09-26T00:00:02Z')),
      await wire(rec('PostToolUse', { tool_name: 'Read', tool_input: { file_path: 'b.ts' } }, '2026-09-26T00:00:03Z')),
    ];
    // 새 저장소로 만든 데이터를 v2 테이블 모양으로 넣는다
    const mem = openSqliteStore(':memory:');
    for (const r of recs) await mem.ingest(A, r);
    const session = (await mem.getSession(A, 'claude-code:s1'))!;
    const turns = await mem.listTurns(A, 'claude-code:s1');
    await mem.close();
    v2.prepare('INSERT INTO sessions VALUES (?, ?, ?, 0, ?)').run(session.key, session.status, session.lastEventAt, JSON.stringify(session));
    for (const t of turns)
      v2.prepare('INSERT INTO turns (session_key, turn_id, prompt, result, status, started_at, ended_at, tool_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        t.sessionKey, t.turnId ?? null, t.prompt ?? null, t.result ?? null, t.status, t.startedAt, t.endedAt ?? null, t.toolCount,
      );
    for (const r of recs)
      v2.prepare('INSERT INTO events (session_key, at, type, native_type, data) VALUES (?, ?, ?, ?, ?)').run(
        'claude-code:s1', r.signal.at, r.signal.type, r.signal.nativeType, JSON.stringify({ signal: r.signal, content: r.content }),
      );
    v2.close();

    const s = openSqliteStore(file);
    expect(s.backupPath).toBeUndefined();
    expect((await view(await s.getSession(A, 'claude-code:s1')))?.title).toBe('옮겨질 작업');
    expect(await s.listTurns(A, 'claude-code:s1')).toHaveLength(1);
    // 실패한 도구만 타임라인에 남는다 — tool_failed 열이 옛 데이터에서 채워졌는지
    expect((await s.listTimeline(A, 'claude-code:s1')).map((t) => t.nativeType)).toEqual(['PostToolUseFailure', 'UserPromptSubmit']);
    await s.close();
  });
});

describe('샘플 fixtures 재생', () => {
  it('실측 샘플 전체를 봉인해 넣어도 오류 없이 처리된다', async () => {
    const file = join(import.meta.dirname, '../../shared/test/fixtures/claude-code-sample.jsonl');
    for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      const r = JSON.parse(line);
      const res = await post({ source: r.source, receivedAt: r.receivedAt, payload: r.payload });
      expect((await res.json()).accepted).toBe(true);
    }
    expect(keys.kid).toHaveLength(8);
  });
});
