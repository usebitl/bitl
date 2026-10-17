import { deriveKeys, generateMasterKey, open as openSealed, seal } from '@bitl/shared/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { type Goal, GoalStore, MAX_GOALS, type SqlStore } from '../src/store/index.js';
import { DATABASES } from './databases.js';


const keys = await deriveKeys(generateMasterKey());
const sealGoal = (id: string, title: string, members: string[]) => seal(keys, JSON.stringify({ title, members }), `goal:${id}`);

describe.each(DATABASES)('goals — %s', (_, open) => {
  let store: SqlStore;
  let goals: GoalStore;
  let app: ReturnType<typeof createApp>;
  let writable = true;
  const access = { canWrite: async () => writable };

  beforeEach(async () => {
    store = await open();
    goals = new GoalStore(store.db);
    writable = true;
    app = createApp({ store, goals, access, account: (c) => c.req.header('x-account') ?? null });
  });
  afterEach(() => store.close());

  const call = (account: string, method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { 'content-type': 'application/json', 'x-account': account },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it('creates and returns the sealed content as is — the server cannot read it', async () => {
    const data = await sealGoal('goal_aaaaaaaa', '오늘 긴급 배포', ['claude-code:s1', 'codex:s2']);
    const res = await call('u1', 'POST', '/api/goals', { id: 'goal_aaaaaaaa', data });
    expect(res.status).toBe(201);
    const list = (await (await call('u1', 'GET', '/api/goals')).json()) as Goal[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'goal_aaaaaaaa', version: 1 });
    expect(JSON.parse(await openSealed(keys, list[0]!.data, 'goal:goal_aaaaaaaa'))).toEqual({ title: '오늘 긴급 배포', members: ['claude-code:s1', 'codex:s2'] });
    // not visible from another account
    expect(await (await call('u2', 'GET', '/api/goals')).json()).toEqual([]);
  });

  it('rejects unsealed content, bad ids and duplicate ids', async () => {
    expect((await call('u1', 'POST', '/api/goals', { id: 'goal_aaaaaaaa', data: '평문 제목' })).status).toBe(400);
    expect((await call('u1', 'POST', '/api/goals', { id: 'x', data: await sealGoal('x', 't', []) })).status).toBe(400);
    const data = await sealGoal('goal_aaaaaaaa', 't', []);
    expect((await call('u1', 'POST', '/api/goals', { id: 'goal_aaaaaaaa', data })).status).toBe(201);
    expect((await call('u1', 'POST', '/api/goals', { id: 'goal_aaaaaaaa', data })).status).toBe(409);
  });

  it('edits only with a matching version — a stale version gets 409 and the latest goal', async () => {
    await call('u1', 'POST', '/api/goals', { id: 'goal_aaaaaaaa', data: await sealGoal('goal_aaaaaaaa', 't', []) });
    const data2 = await sealGoal('goal_aaaaaaaa', 't', ['claude-code:s1']);
    const ok = await call('u1', 'PUT', '/api/goals/goal_aaaaaaaa', { version: 1, data: data2 });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as Goal).version).toBe(2);

    const stale = await call('u1', 'PUT', '/api/goals/goal_aaaaaaaa', { version: 1, data: await sealGoal('goal_aaaaaaaa', 'x', []) });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { goal: Goal }).goal).toMatchObject({ version: 2, data: data2 });
    expect((await call('u1', 'PUT', '/api/goals/nope_nope_nope', { version: 1 })).status).toBe(404);
  });

  it('closed goals drop out of the list, show with ?closed=1 and can be reopened', async () => {
    await call('u1', 'POST', '/api/goals', { id: 'goal_aaaaaaaa', data: await sealGoal('goal_aaaaaaaa', 't', []) });
    const closed = (await (await call('u1', 'PUT', '/api/goals/goal_aaaaaaaa', { version: 1, closed: true })).json()) as Goal;
    expect(closed.closedAt).toBeTruthy();
    expect(await (await call('u1', 'GET', '/api/goals')).json()).toEqual([]);
    expect((await (await call('u1', 'GET', '/api/goals?closed=1')).json()) as Goal[]).toHaveLength(1);
    const reopened = (await (await call('u1', 'PUT', '/api/goals/goal_aaaaaaaa', { version: 2, closed: false })).json()) as Goal;
    expect(reopened.closedAt).toBeUndefined();
  });

  it('delete; subscribers are notified on every change', async () => {
    const seen: string[] = [];
    const off = goals.subscribe((c) => seen.push(c.type === 'goal' ? `goal:${c.goal.version}` : `removed:${c.id}`));
    await call('u1', 'POST', '/api/goals', { id: 'goal_aaaaaaaa', data: await sealGoal('goal_aaaaaaaa', 't', []) });
    await call('u1', 'PUT', '/api/goals/goal_aaaaaaaa', { version: 1, closed: true });
    expect((await call('u1', 'DELETE', '/api/goals/goal_aaaaaaaa')).status).toBe(200);
    expect((await call('u1', 'DELETE', '/api/goals/goal_aaaaaaaa')).status).toBe(404);
    off();
    expect(seen).toEqual(['goal:1', 'goal:2', 'removed:goal_aaaaaaaa']);
  });

  it('clearing the board deletes goals only when asked, and only this account’s', async () => {
    for (const [account, id] of [['u1', 'goal_aaaaaaaa'], ['u2', 'goal_bbbbbbbb']])
      await call(account!, 'POST', '/api/goals', { id, data: await sealGoal(id!, 't', []) });
    expect(await (await call('u1', 'POST', '/api/board/clear', {})).json()).toEqual({ deleted: 0, cleared: 0, goals: 0 });
    expect(await goals.list('u1')).toHaveLength(1);
    expect(await (await call('u1', 'POST', '/api/board/clear', { goals: true })).json()).toEqual({ deleted: 0, cleared: 0, goals: 1 });
    expect(await goals.list('u1')).toHaveLength(0);
    expect(await goals.list('u2')).toHaveLength(1);
  });

  it('read-only accounts get 402 on create/edit, delete still works', async () => {
    await call('u1', 'POST', '/api/goals', { id: 'goal_aaaaaaaa', data: await sealGoal('goal_aaaaaaaa', 't', []) });
    writable = false;
    expect((await call('u1', 'POST', '/api/goals', { id: 'goal_bbbbbbbb', data: await sealGoal('goal_bbbbbbbb', 't', []) })).status).toBe(402);
    expect((await call('u1', 'PUT', '/api/goals/goal_aaaaaaaa', { version: 1, closed: true })).status).toBe(402);
    expect((await call('u1', 'DELETE', '/api/goals/goal_aaaaaaaa')).status).toBe(200);
  });

  it(`up to ${MAX_GOALS} per account`, async () => {
    const data = await sealGoal('goal_cap', 't', []);
    for (let i = 0; i < MAX_GOALS; i++) await goals.create('u1', `goal_${String(i).padStart(8, '0')}`, data);
    expect(await goals.create('u1', 'goal_overflow', data)).toBeUndefined();
  });
});
