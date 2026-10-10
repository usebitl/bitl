import { SEALED_PATTERN } from '@bitl/shared/client';
import type { Hono } from 'hono';
import { type AccessPolicy, allowAll } from './access.js';
import type { GoalStore } from './store/index.js';

type Env = { Variables: { accountId: string; deviceId?: string } };

/** Goal id — created by the browser (it goes into the seal's AAD) */
const GOAL_ID = /^[A-Za-z0-9_-]{8,32}$/;
/** Max length of the sealed { title, members } (room for hundreds of linked cards) */
const MAX_DATA = 64_000;

const validData = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_DATA && SEALED_PATTERN.test(v);

/**
 * Goals API (account-scoped). Contents are sealed, so the server doesn't inspect them — it only stores and relays.
 *   GET    /api/goals[?closed=1]         list goals (default: open ones)
 *   POST   /api/goals {id, data}         create
 *   PUT    /api/goals/:id {version, data?, closed?}   edit / close / reopen — 409 {goal: latest} if version is stale
 *   DELETE /api/goals/:id                delete (linked cards stay)
 * Read-only (subscription ended): create/edit return 402. Delete and read still work.
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
