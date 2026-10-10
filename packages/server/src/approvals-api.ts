import { APPROVAL_ID_PATTERN, APPROVAL_SIG_PATTERN, SEALED_PATTERN } from '@bitl/shared/client';
import type { Hono } from 'hono';
import { type AccessPolicy, allowAll } from './access.js';
import { type ApprovalStore, MAX_APPROVAL_TTL_MS, type SessionStore } from './store/index.js';

type Env = { Variables: { accountId: string; deviceId?: string } };

/** Max time the PC holds a single wait (shorter than proxy/Caddy timeouts). It asks again afterwards */
const MAX_WAIT_MS = 25_000;

/**
 * When a card leaves "waiting for you", close that card's pending approval requests.
 * Even with remote approval on, the terminal prompt still appears and the first answer wins — once answered in the terminal, the phone/board request is moot.
 * (If answered on the phone, the request is already decided and no longer pending)
 */
export function closeApprovalsOnResume(store: SessionStore, approvals: ApprovalStore, onError?: (err: unknown) => void): () => void {
  return store.subscribe((change) => {
    if (change.type !== 'session' || change.prevStatus !== 'waiting_for_you' || change.session.status === 'waiting_for_you') return;
    approvals.cancelForSession(change.accountId, change.session.key).catch((err) => onError?.(err));
  });
}

/**
 * Remote approval API (account-scoped). The server only relays — request contents are sealed; the phone signs the decision and the PC verifies it.
 *   GET  /api/approvals/mode            whether remote approval is on {away} (decides whether the PC hook posts requests)
 *   PUT  /api/approvals/mode {away}     turn remote approval on/off (board, bitl remote). The field name away is kept from the original "away mode" name to match installed hooks
 *   POST /api/approvals                 PC: new request {id, sessionKey, request (sealed), ttlSec}
 *   GET  /api/approvals                 board: pending requests
 *   GET  /api/approvals/:id             status
 *   GET  /api/approvals/:id/wait        PC: wait until decided or up to 25 s, then return the status
 *   POST /api/approvals/:id/decide      phone: {decision, sig} — first decision wins
 *   POST /api/approvals/:id/cancel      PC: stop waiting (answering in the terminal instead)
 */
export function mountApprovals(app: Hono<Env>, approvals: ApprovalStore, access: AccessPolicy = allowAll) {
  const notFound = { error: 'not found' } as const;

  // Read-only accounts get "off" → the PC hook backs off immediately to terminal approval (the toggle itself is remembered)
  app.get('/api/approvals/mode', async (c) =>
    c.json({ away: (await approvals.isAway(c.var.accountId)) && (await access.canWrite(c.var.accountId)) }),
  );

  app.put('/api/approvals/mode', async (c) => {
    const b = (await c.req.json().catch(() => null)) as { away?: unknown } | null;
    if (typeof b?.away !== 'boolean') return c.json({ error: 'away must be boolean' }, 400);
    await approvals.setAway(c.var.accountId, b.away);
    return c.json({ away: b.away });
  });

  app.post('/api/approvals', async (c) => {
    if (!(await access.canWrite(c.var.accountId))) return c.json({ error: 'subscription_required' }, 402);
    const b = (await c.req.json().catch(() => null)) as { id?: unknown; sessionKey?: unknown; request?: unknown; ttlSec?: unknown } | null;
    const { id, sessionKey, request, ttlSec } = b ?? {};
    if (
      typeof id !== 'string' ||
      !APPROVAL_ID_PATTERN.test(id) ||
      typeof sessionKey !== 'string' ||
      sessionKey.length > 300 ||
      typeof request !== 'string' ||
      request.length > 20_000 ||
      !SEALED_PATTERN.test(request) ||
      typeof ttlSec !== 'number' ||
      !Number.isFinite(ttlSec)
    )
      return c.json({ error: 'invalid approval' }, 400);
    const a = await approvals.create(c.var.accountId, {
      id,
      sessionKey,
      request,
      deviceId: c.var.deviceId,
      ttlMs: Math.min(ttlSec * 1000, MAX_APPROVAL_TTL_MS),
    });
    return a ? c.json(a, 201) : c.json({ error: 'duplicate id' }, 409);
  });

  app.get('/api/approvals', async (c) => c.json(await approvals.listPending(c.var.accountId)));

  app.get('/api/approvals/:id', async (c) => {
    const a = await approvals.get(c.var.accountId, c.req.param('id'));
    return a ? c.json(a) : c.json(notFound, 404);
  });

  app.get('/api/approvals/:id/wait', async (c) => {
    const [accountId, id] = [c.var.accountId, c.req.param('id')];
    const ms = Math.min(Math.max(Number(c.req.query('ms') ?? MAX_WAIT_MS) || 0, 0), MAX_WAIT_MS);
    // Subscribe first, then read (so a decision in between isn't missed)
    let wake: (() => void) | undefined;
    const off = approvals.subscribe((ch) => {
      if (ch.accountId === accountId && ch.approval.id === id && ch.approval.status !== 'pending') wake?.();
    });
    try {
      let a = await approvals.get(accountId, id);
      if (!a) return c.json(notFound, 404);
      if (a.status === 'pending' && ms > 0) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, ms);
          wake = () => {
            clearTimeout(t);
            resolve();
          };
          c.req.raw.signal.addEventListener('abort', wake, { once: true });
        });
        a = (await approvals.get(accountId, id)) ?? a;
      }
      return c.json(a);
    } finally {
      off();
    }
  });

  app.post('/api/approvals/:id/decide', async (c) => {
    const b = (await c.req.json().catch(() => null)) as { decision?: unknown; sig?: unknown } | null;
    const { decision, sig } = b ?? {};
    // The server can't verify the signature (it has no key) — only the shape is checked. The PC verifies it
    if ((decision !== 'allow' && decision !== 'deny') || typeof sig !== 'string' || !APPROVAL_SIG_PATTERN.test(sig))
      return c.json({ error: 'invalid decision' }, 400);
    const [accountId, id] = [c.var.accountId, c.req.param('id')];
    const a = await approvals.settle(accountId, id, decision, sig);
    if (a) return c.json(a);
    const current = await approvals.get(accountId, id);
    return current ? c.json({ error: 'already settled', approval: current }, 409) : c.json(notFound, 404);
  });

  app.post('/api/approvals/:id/cancel', async (c) => {
    const [accountId, id] = [c.var.accountId, c.req.param('id')];
    const a = await approvals.settle(accountId, id, 'cancelled');
    if (a) return c.json(a);
    const current = await approvals.get(accountId, id);
    return current ? c.json(current) : c.json(notFound, 404);
  });
}
