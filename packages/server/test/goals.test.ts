import { deriveKeys, generateMasterKey, open as openSealed, seal } from '@bitl/shared/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { type Goal, GoalStore, MAX_GOALS, type SqlStore } from '../src/store/index.js';
import { DATABASES } from './databases.js';


const keys = await deriveKeys(generateMasterKey());
const sealGoal = (id: string, title: string, members: string[]) => seal(keys, JSON.stringify({ title, members }), `goal:${id}`);

describe.each(DATABASES)('목표 — %s', (_, open) => {
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

  it('만들고 봉인된 내용을 그대로 돌려준다 — 서버는 내용을 모른다', async () => {
    const data = await sealGoal('goal_aaaaaaaa', '오늘 긴급 배포', ['claude-code:s1', 'codex:s2']);
    const res = await call('u1', 'POST', '/api/goals', { id: 'goal_aaaaaaaa', data });
    expect(res.status).toBe(201);
    const list = (await (await call('u1', 'GET', '/api/goals')).json()) as Goal[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'goal_aaaaaaaa', version: 1 });
    expect(JSON.parse(await openSealed(keys, list[0]!.data, 'goal:goal_aaaaaaaa'))).toEqual({ title: '오늘 긴급 배포', members: ['claude-code:s1', 'codex:s2'] });
    // 다른 계정에서는 안 보인다
    expect(await (await call('u2', 'GET', '/api/goals')).json()).toEqual([]);
  });

  it('봉인되지 않은 내용·잘못된 id·같은 id 는 거절', async () => {
    expect((await call('u1', 'POST', '/api/goals', { id: 'goal_aaaaaaaa', data: '평문 제목' })).status).toBe(400);
    expect((await call('u1', 'POST', '/api/goals', { id: 'x', data: await sealGoal('x', 't', []) })).status).toBe(400);
    const data = await sealGoal('goal_aaaaaaaa', 't', []);
    expect((await call('u1', 'POST', '/api/goals', { id: 'goal_aaaaaaaa', data })).status).toBe(201);
    expect((await call('u1', 'POST', '/api/goals', { id: 'goal_aaaaaaaa', data })).status).toBe(409);
  });

  it('고치기는 version 이 맞을 때만 — 낡은 version 이면 409 와 최신 목표', async () => {
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

  it('마치면 목록에서 빠지고 ?closed=1 로 보인다, 다시 열 수 있다', async () => {
    await call('u1', 'POST', '/api/goals', { id: 'goal_aaaaaaaa', data: await sealGoal('goal_aaaaaaaa', 't', []) });
    const closed = (await (await call('u1', 'PUT', '/api/goals/goal_aaaaaaaa', { version: 1, closed: true })).json()) as Goal;
    expect(closed.closedAt).toBeTruthy();
    expect(await (await call('u1', 'GET', '/api/goals')).json()).toEqual([]);
    expect((await (await call('u1', 'GET', '/api/goals?closed=1')).json()) as Goal[]).toHaveLength(1);
    const reopened = (await (await call('u1', 'PUT', '/api/goals/goal_aaaaaaaa', { version: 2, closed: false })).json()) as Goal;
    expect(reopened.closedAt).toBeUndefined();
  });

  it('지우기, 바뀔 때마다 구독자에게 알린다', async () => {
    const seen: string[] = [];
    const off = goals.subscribe((c) => seen.push(c.type === 'goal' ? `goal:${c.goal.version}` : `removed:${c.id}`));
    await call('u1', 'POST', '/api/goals', { id: 'goal_aaaaaaaa', data: await sealGoal('goal_aaaaaaaa', 't', []) });
    await call('u1', 'PUT', '/api/goals/goal_aaaaaaaa', { version: 1, closed: true });
    expect((await call('u1', 'DELETE', '/api/goals/goal_aaaaaaaa')).status).toBe(200);
    expect((await call('u1', 'DELETE', '/api/goals/goal_aaaaaaaa')).status).toBe(404);
    off();
    expect(seen).toEqual(['goal:1', 'goal:2', 'removed:goal_aaaaaaaa']);
  });

  it('읽기 전용 계정은 만들기·고치기 402, 지우기는 된다', async () => {
    await call('u1', 'POST', '/api/goals', { id: 'goal_aaaaaaaa', data: await sealGoal('goal_aaaaaaaa', 't', []) });
    writable = false;
    expect((await call('u1', 'POST', '/api/goals', { id: 'goal_bbbbbbbb', data: await sealGoal('goal_bbbbbbbb', 't', []) })).status).toBe(402);
    expect((await call('u1', 'PUT', '/api/goals/goal_aaaaaaaa', { version: 1, closed: true })).status).toBe(402);
    expect((await call('u1', 'DELETE', '/api/goals/goal_aaaaaaaa')).status).toBe(200);
  });

  it(`계정당 ${MAX_GOALS}개까지`, async () => {
    const data = await sealGoal('goal_cap', 't', []);
    for (let i = 0; i < MAX_GOALS; i++) await goals.create('u1', `goal_${String(i).padStart(8, '0')}`, data);
    expect(await goals.create('u1', 'goal_overflow', data)).toBeUndefined();
  });
});
