// Account isolation at the API level. Real account resolution (login, device key) is Phase 4 items 2–3 — here it's faked with a header.
import type { StoredSession } from '@bitl/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openSqliteStore, type SessionStore } from '../src/store/index.js';
import { wire } from './helpers.js';

let store: SessionStore;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  store = openSqliteStore(':memory:');
  app = createApp({ store, account: (c) => c.req.header('x-account') ?? null });
});
afterEach(() => store.close());

const as = (account: string | undefined, path: string, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { 'content-type': 'application/json', ...(account ? { 'x-account': account } : {}) } });

const prompt = async (account: string, sessionId: string, text: string) =>
  as(account, '/api/events', {
    method: 'POST',
    body: JSON.stringify(await wire({ source: 'claude-code', payload: { session_id: sessionId, hook_event_name: 'UserPromptSubmit', prompt: text } })),
  });

describe('account isolation (API)', () => {
  it('401 when the account is unknown; health stays open', async () => {
    expect((await as(undefined, '/api/sessions')).status).toBe(401);
    expect((await as(undefined, '/api/events', { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await as(undefined, '/api/health')).status).toBe(200);
  });

  it('list, detail, edit and delete see only the own account', async () => {
    await prompt('a', 's1', 'A 작업');
    await prompt('b', 's2', 'B 작업');

    const listA = (await (await as('a', '/api/sessions')).json()) as StoredSession[];
    expect(listA.map((s) => s.key)).toEqual(['claude-code:s1']);
    expect((await as('a', '/api/sessions/claude-code:s2')).status).toBe(404);
    expect((await as('a', '/api/sessions/claude-code:s2', { method: 'PATCH', body: JSON.stringify({ pinned: true }) })).status).toBe(404);
    expect((await as('a', '/api/sessions/claude-code:s2/ack', { method: 'POST' })).status).toBe(404);
    expect((await as('a', '/api/sessions/claude-code:s2', { method: 'DELETE' })).status).toBe(404);
    expect(await store.getSession('b', 'claude-code:s2')).toBeDefined();
  });

  it('SSE sends only the snapshot and changes of its own account', async () => {
    await prompt('a', 's1', 'A 작업');
    await prompt('b', 's9', 'B 작업');

    const res = await as('a', '/api/stream');
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const until = async (needle: string) => {
      while (!buf.includes(needle)) buf += dec.decode((await reader.read()).value);
    };
    await until('event: snapshot');
    await prompt('b', 's9', 'B 의 다음 지시'); // change in another account
    await prompt('a', 's2', 'A 의 새 세션');
    await until('claude-code:s2');
    await reader.cancel();

    expect(buf).toContain('claude-code:s1');
    expect(buf).not.toContain('claude-code:s9');
  });
});
