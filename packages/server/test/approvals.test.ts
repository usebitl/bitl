import { newApprovalId, sealApprovalRequest, describeToolRequest, signDecision, verifyDecision } from '@bitl/shared/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeApprovalsOnResume } from '../src/approvals-api.js';
import { createApp } from '../src/app.js';
import { type PushSender, startPushNotifier } from '../src/push.js';
import { ApprovalStore, PushStore, type SqlStore } from '../src/store/index.js';
import { DATABASES } from './databases.js';
import { keys, wire } from './helpers.js';


describe.each(DATABASES)('원격 승인 — %s', (_, open) => {
let store: SqlStore;
let approvals: ApprovalStore;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  store = await open();
  approvals = new ApprovalStore(store.db);
  app = createApp({ store, approvals, account: (c) => c.req.header('x-account') ?? null });
});
afterEach(() => store.close());

const call = (account: string, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-account': account },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function newRequest(account = 'u1', ttlSec = 300) {
  const id = newApprovalId();
  const request = await sealApprovalRequest(keys, id, describeToolRequest('Bash', { command: 'rm -rf dist' }));
  const res = await call(account, 'POST', '/api/approvals', { id, sessionKey: 'claude-code:s1', request, ttlSec });
  return { id, request, res };
}

describe('원격 승인 켜기·끄기', () => {
  it('기본은 꺼짐, 계정마다 따로', async () => {
    expect(await (await call('u1', 'GET', '/api/approvals/mode')).json()).toEqual({ away: false });
    expect((await call('u1', 'PUT', '/api/approvals/mode', { away: true })).status).toBe(200);
    expect(await (await call('u1', 'GET', '/api/approvals/mode')).json()).toEqual({ away: true });
    expect(await (await call('u2', 'GET', '/api/approvals/mode')).json()).toEqual({ away: false });
    expect((await call('u1', 'PUT', '/api/approvals/mode', { away: 'yes' })).status).toBe(400);
  });
});

describe('승인 요청 → 결정', () => {
  it('PC 가 올리고, 폰이 서명한 결정을 PC 가 기다렸다 받아 서명을 확인한다', async () => {
    const { id, res } = await newRequest();
    expect(res.status).toBe(201);
    expect((await (await call('u1', 'GET', '/api/approvals')).json()).map((a: { id: string }) => a.id)).toEqual([id]);

    // PC 가 기다리는 중에 폰이 결정
    const waiting = call('u1', 'GET', `/api/approvals/${id}/wait?ms=5000`);
    await new Promise((r) => setTimeout(r, 50));
    const sig = await signDecision(keys, id, 'allow');
    expect((await call('u1', 'POST', `/api/approvals/${id}/decide`, { decision: 'allow', sig })).status).toBe(200);
    const got = await (await waiting).json();
    expect(got).toMatchObject({ id, status: 'allow', sig });
    expect(await verifyDecision(keys, id, got.status, got.sig)).toBe(true);
    // 결정이 났으면 목록에서 빠진다
    expect(await (await call('u1', 'GET', '/api/approvals')).json()).toEqual([]);
  });

  it('먼저 온 결정만 — 두 번째는 409', async () => {
    const { id } = await newRequest();
    await call('u1', 'POST', `/api/approvals/${id}/decide`, { decision: 'deny', sig: await signDecision(keys, id, 'deny') });
    const again = await call('u1', 'POST', `/api/approvals/${id}/decide`, { decision: 'allow', sig: await signDecision(keys, id, 'allow') });
    expect(again.status).toBe(409);
    expect((await (await call('u1', 'GET', `/api/approvals/${id}`)).json()).status).toBe('deny');
  });

  it('다른 계정은 보지도 결정하지도 못한다', async () => {
    const { id } = await newRequest('u1');
    expect((await call('u2', 'GET', `/api/approvals/${id}`)).status).toBe(404);
    expect(await (await call('u2', 'GET', '/api/approvals')).json()).toEqual([]);
    const sig = await signDecision(keys, id, 'allow');
    expect((await call('u2', 'POST', `/api/approvals/${id}/decide`, { decision: 'allow', sig })).status).toBe(404);
  });

  it('기다리는 시간이 지나면 pending 그대로 돌려준다 (PC 가 다시 묻는다)', async () => {
    const { id } = await newRequest();
    const t = Date.now();
    expect(await (await call('u1', 'GET', `/api/approvals/${id}/wait?ms=200`)).json()).toMatchObject({ status: 'pending' });
    expect(Date.now() - t).toBeGreaterThanOrEqual(150);
  });

  it('PC 가 그만 기다리면(cancel) 결정을 받지 않는다', async () => {
    const { id } = await newRequest();
    expect((await (await call('u1', 'POST', `/api/approvals/${id}/cancel`)).json()).status).toBe('cancelled');
    const sig = await signDecision(keys, id, 'allow');
    expect((await call('u1', 'POST', `/api/approvals/${id}/decide`, { decision: 'allow', sig })).status).toBe(409);
  });

  it('만료되면 결정을 받지 않고 sweep 이 expired 로 바꾼다', async () => {
    const { id } = await newRequest('u1', 10);
    const later = new Date(Date.now() + 11_000);
    expect(await approvals.settle('u1', id, 'allow', 'x'.repeat(43), later)).toBeUndefined();
    expect(await approvals.sweep(later)).toBe(1);
    expect((await approvals.get('u1', id))?.status).toBe('expired');
  });

  it.each([
    ['평문 요청', { request: 'rm -rf dist' }],
    ['id 형식', { id: 'short' }],
    ['ttl 없음', { ttlSec: undefined }],
  ])('잘못된 요청은 거절: %s', async (_, patch) => {
    const id = newApprovalId();
    const request = await sealApprovalRequest(keys, id, describeToolRequest('Bash', { command: 'ls' }));
    const res = await call('u1', 'POST', '/api/approvals', { id, sessionKey: 'k', request, ttlSec: 60, ...patch });
    expect(res.status).toBe(400);
  });

  it('서명 모양이 아니면 결정을 받지 않는다', async () => {
    const { id } = await newRequest();
    expect((await call('u1', 'POST', `/api/approvals/${id}/decide`, { decision: 'allow', sig: 'nope' })).status).toBe(400);
    expect((await call('u1', 'POST', `/api/approvals/${id}/decide`, { decision: 'yes', sig: 'A'.repeat(43) })).status).toBe(400);
  });
});

describe('터미널에서 먼저 답하면', () => {
  const hook = (event: string, extra: Record<string, unknown> = {}) =>
    wire({ source: 'claude-code', receivedAt: new Date().toISOString(), payload: { session_id: 's1', cwd: 'C:/work/api', hook_event_name: event, ...extra } }).then(
      (rec) => store.ingest('u1', rec),
    );

  it('카드가 나를 기다림을 벗어날 때 남은 승인 요청을 닫는다', async () => {
    const off = closeApprovalsOnResume(store, approvals);
    await hook('UserPromptSubmit', { prompt: '배포' });
    await hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } });
    const { id } = await newRequest('u1');
    // 다른 카드의 요청은 그대로
    const other = newApprovalId();
    await approvals.create('u1', { id: other, sessionKey: 'claude-code:s2', request: (await newRequest('u1')).request, ttlMs: 60_000 });
    // 터미널에서 허용 → 도구 실행 완료
    await hook('PostToolUse', { tool_name: 'Bash' });
    await new Promise((r) => setTimeout(r, 50));
    off();
    expect((await approvals.get('u1', id))?.status).toBe('cancelled');
    expect((await approvals.get('u1', other))?.status).toBe('pending');
  });
});

describe('승인 요청 알림', () => {
  it('새 요청마다 그 계정의 기기로 보낸다 (봉인된 요청 포함)', async () => {
    const push = new PushStore(store.db);
    await push.subscribe('u1', { endpoint: 'https://push.example.com/1', p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) });
    const sent: { payload: Record<string, unknown> }[] = [];
    const sender: PushSender = async (_sub, payload) => (sent.push({ payload: JSON.parse(payload) }), 'ok');
    const notifier = startPushNotifier({ store, push, sender, approvals });
    const { id, request } = await newRequest('u1');
    await newRequest('u2');
    await notifier.idle();
    notifier.stop();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload).toMatchObject({ v: 1, kind: 'approval', id, key: 'claude-code:s1', request });
  });

  it('끝나면 같은 기기로 정리 알림 (같은 topic — 전달 안 된 요청 알림을 바꾼다)', async () => {
    const push = new PushStore(store.db);
    await push.subscribe('u1', { endpoint: 'https://push.example.com/1', p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) });
    const sent: { payload: Record<string, unknown>; topic: string }[] = [];
    const sender: PushSender = async (_sub, payload, topic) => (sent.push({ payload: JSON.parse(payload), topic }), 'ok');
    const notifier = startPushNotifier({ store, push, sender, approvals });
    const { id } = await newRequest('u1');
    await approvals.settle('u1', id, 'cancelled');
    await notifier.idle();
    notifier.stop();
    expect(sent.map((s) => s.payload.kind)).toEqual(['approval', 'approval-settled']);
    expect(sent[1]!.payload).toMatchObject({ id, key: 'claude-code:s1', status: 'cancelled' });
    expect(sent[1]!.topic).toBe(sent[0]!.topic);
  });
});
});
