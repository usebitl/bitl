import { SEALED_PATTERN } from '@bitl/shared/client';
import type { Hono } from 'hono';
import { type AccessPolicy, allowAll } from './access.js';
import type { GoalStore } from './store/index.js';

type Env = { Variables: { accountId: string; deviceId?: string } };

/** 목표 id — 브라우저가 만든다 (봉인 AAD 에 들어가므로) */
const GOAL_ID = /^[A-Za-z0-9_-]{8,32}$/;
/** 봉인된 { title, members } 의 최대 길이 (카드 수백 개를 연결해도 넉넉하게) */
const MAX_DATA = 64_000;

const validData = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_DATA && SEALED_PATTERN.test(v);

/**
 * 목표 API (계정 안에서만). 내용은 봉인돼 있어 서버는 검사하지 않고 보관·중계만 한다.
 *   GET    /api/goals[?closed=1]         목표 목록 (기본: 마치지 않은 것)
 *   POST   /api/goals {id, data}         만들기
 *   PUT    /api/goals/:id {version, data?, closed?}   고치기·마치기·다시 열기 — version 이 낡았으면 409 {goal: 최신}
 *   DELETE /api/goals/:id                지우기 (연결된 카드는 그대로)
 * 읽기 전용(구독 끝남)이면 만들기·고치기는 402. 지우기와 읽기는 된다.
 */
export function mountGoals(app: Hono<Env>, goals: GoalStore, access: AccessPolicy = allowAll) {
  const notFound = { error: 'not found' } as const;
  const readonly = { error: 'subscription_required' } as const;

  app.get('/api/goals', async (c) => c.json(await goals.list(c.var.accountId, c.req.query('closed') === '1')));

  app.post('/api/goals', async (c) => {
    if (!(await access.canWrite(c.var.accountId))) return c.json(readonly, 402);
    const body = (await c.req.json().catch(() => null)) as { id?: unknown; data?: unknown } | null;
    if (typeof body?.id !== 'string' || !GOAL_ID.test(body.id) || !validData(body.data)) return c.json({ error: 'invalid body' }, 400);
    const goal = await goals.create(c.var.accountId, body.id, body.data);
    return goal ? c.json(goal, 201) : c.json({ error: 'goal exists or too many goals' }, 409);
  });

  app.put('/api/goals/:id', async (c) => {
    if (!(await access.canWrite(c.var.accountId))) return c.json(readonly, 402);
    const body = (await c.req.json().catch(() => null)) as { version?: unknown; data?: unknown; closed?: unknown } | null;
    if (!body || !Number.isInteger(body.version)) return c.json({ error: 'invalid body' }, 400);
    if (body.data !== undefined && !validData(body.data)) return c.json({ error: 'invalid data' }, 400);
    if (body.closed !== undefined && typeof body.closed !== 'boolean') return c.json({ error: 'invalid closed' }, 400);
    const r = await goals.update(c.var.accountId, c.req.param('id'), body.version as number, {
      data: body.data as string | undefined,
      closed: body.closed as boolean | undefined,
    });
    if (!r) return c.json(notFound, 404);
    return 'conflict' in r ? c.json({ error: 'conflict', goal: r.conflict }, 409) : c.json(r.goal);
  });

  app.delete('/api/goals/:id', async (c) =>
    (await goals.delete(c.var.accountId, c.req.param('id'))) ? c.json({ ok: true }) : c.json(notFound, 404),
  );
}
