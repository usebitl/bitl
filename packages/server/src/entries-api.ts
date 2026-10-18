import { SEALED_PATTERN } from '@bitl/shared/client';
import type { Hono } from 'hono';
import { type AccessPolicy, allowAll } from './access.js';
import type { EntryStore } from './store/index.js';

type Env = { Variables: { accountId: string; deviceId?: string } };

/** Entry id — created by the browser (it goes into the seal's AAD) */
const ENTRY_ID = /^[A-Za-z0-9_-]{8,32}$/;
/** Max length of the sealed entry (280 chars of text plus where it was written) */
const MAX_DATA = 8_000;
const MAX_KEY = 300;

const validData = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_DATA && SEALED_PATTERN.test(v);
const validTime = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));

/**
 * Entries API (account-scoped) — the short notes a person leaves along the way. Contents are sealed; the server stores and relays.
 *   GET    /api/entries[?session=&since=&before=&limit=]   newest first
 *   POST   /api/entries {id, data, sessionKey?}            write
 *   PUT    /api/entries/:id {data}                          rewrite (the time it was written stays)
 *   DELETE /api/entries/:id
 * Read-only (subscription ended): write/rewrite return 402. Read and delete still work.
 */
export function mountEntries(app: Hono<Env>, entries: EntryStore, access: AccessPolicy = allowAll) {
  const notFound = { error: 'not found' } as const;
  const readonly = { error: 'subscription_required' } as const;

  app.get('/api/entries', async (c) => {
    const q = (k: string) => c.req.query(k) || undefined;
    const since = q('since');
    const before = q('before');
    if ((since && !validTime(since)) || (before && !validTime(before))) return c.json({ error: 'invalid time' }, 400);
    const limit = Number(q('limit') ?? 200);
    return c.json(await entries.list(c.var.accountId, { session: q('session'), since, before, limit: Number.isFinite(limit) ? limit : 200 }));
  });

  app.post('/api/entries', async (c) => {
    if (!(await access.canWrite(c.var.accountId))) return c.json(readonly, 402);
    const body = (await c.req.json().catch(() => null)) as { id?: unknown; data?: unknown; sessionKey?: unknown } | null;
    if (typeof body?.id !== 'string' || !ENTRY_ID.test(body.id) || !validData(body.data)) return c.json({ error: 'invalid body' }, 400);
    if (body.sessionKey !== undefined && (typeof body.sessionKey !== 'string' || !body.sessionKey || body.sessionKey.length > MAX_KEY))
      return c.json({ error: 'invalid sessionKey' }, 400);
    const entry = await entries.create(c.var.accountId, body.id, body.data, body.sessionKey as string | undefined);
    return entry ? c.json(entry, 201) : c.json({ error: 'entry exists or too many entries' }, 409);
  });

  app.put('/api/entries/:id', async (c) => {
    if (!(await access.canWrite(c.var.accountId))) return c.json(readonly, 402);
    const body = (await c.req.json().catch(() => null)) as { data?: unknown } | null;
    if (!validData(body?.data)) return c.json({ error: 'invalid body' }, 400);
    const entry = await entries.update(c.var.accountId, c.req.param('id'), body.data);
    return entry ? c.json(entry) : c.json(notFound, 404);
  });

  app.delete('/api/entries/:id', async (c) =>
    (await entries.delete(c.var.accountId, c.req.param('id'))) ? c.json({ ok: true }) : c.json(notFound, 404),
  );
}
