import { APPROVAL_ID_PATTERN, APPROVAL_SIG_PATTERN, SEALED_PATTERN } from '@bitl/shared/client';
import type { Hono } from 'hono';
import { type AccessPolicy, allowAll } from './access.js';
import { type ApprovalStore, MAX_APPROVAL_TTL_MS, type SessionStore } from './store/index.js';

type Env = { Variables: { accountId: string; deviceId?: string } };

/** PC 가 한 번에 붙잡고 기다리는 최대 시간 (프록시·Caddy 시간 제한보다 짧게). 그 뒤 다시 묻는다 */
const MAX_WAIT_MS = 25_000;

/**
 * 카드가 "나를 기다림"에서 다른 상태로 바뀌면 그 카드의 기다리는 승인 요청을 닫는다.
 * 원격 승인이 켜져 있어도 터미널 승인 창은 뜨고 먼저 온 답이 이긴다 — 터미널에서 답했으면 폰·보드의 요청은 의미가 없다.
 * (폰에서 답했으면 그 요청은 이미 결정돼 pending 이 아니다)
 */
export function closeApprovalsOnResume(store: SessionStore, approvals: ApprovalStore, onError?: (err: unknown) => void): () => void {
  return store.subscribe((change) => {
    if (change.type !== 'session' || change.prevStatus !== 'waiting_for_you' || change.session.status === 'waiting_for_you') return;
    approvals.cancelForSession(change.accountId, change.session.key).catch((err) => onError?.(err));
  });
}

/**
 * 원격 승인 API (계정 안에서만). 서버는 중계만 한다 — 요청 내용은 봉인돼 있고, 결정의 서명은 폰이 만들고 PC 가 확인한다.
 *   GET  /api/approvals/mode            원격 승인이 켜졌는지 {away} (PC hook 이 요청을 올릴지 정한다)
 *   PUT  /api/approvals/mode {away}     원격 승인 켜기·끄기 (보드, bitl remote). 필드 이름 away 는 처음 이름(자리 비움) 그대로 — 설치된 hook 과 맞춘다
 *   POST /api/approvals                 PC: 새 요청 {id, sessionKey, request(봉인), ttlSec}
 *   GET  /api/approvals                 보드: 기다리는 요청 목록
 *   GET  /api/approvals/:id             상태
 *   GET  /api/approvals/:id/wait        PC: 결정이 나거나 최대 25초 지날 때까지 기다렸다가 상태
 *   POST /api/approvals/:id/decide      폰: {decision, sig} — 먼저 온 결정이 이긴다
 *   POST /api/approvals/:id/cancel      PC: 그만 기다림 (터미널에서 직접 답하기로)
 */
export function mountApprovals(app: Hono<Env>, approvals: ApprovalStore, access: AccessPolicy = allowAll) {
  const notFound = { error: 'not found' } as const;

  // 읽기 전용이면 꺼진 것으로 답한다 → PC hook 은 바로 물러나 터미널에서 승인 (스위치 자체는 그대로 기억)
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
    // 먼저 구독하고 나서 읽는다 (그 사이의 결정을 놓치지 않게)
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
    // 서버는 서명을 확인할 수 없다 (키가 없다) — 모양만 본다. 확인은 PC 가 한다
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
