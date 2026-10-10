import { newApprovalId, sealApprovalRequest, describeToolRequest, signDecision, verifyDecision } from '@bitl/shared/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeApprovalsOnResume } from '../src/approvals-api.js';
import { createApp } from '../src/app.js';
import { type PushSender, startPushNotifier } from '../src/push.js';
import { ApprovalStore, PushStore, type SqlStore } from '../src/store/index.js';
import { DATABASES } from './databases.js';
import { keys, wire } from './helpers.js';


describe.each(DATABASES)('remote approval — %s', (_, open) => {
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

describe('remote approval on/off', () => {
  it('off by default, per account', async () => {
    expect(await (await call('u1', 'GET', '/api/approvals/mode')).json()).toEqual({ away: false });
    expect((await call('u1', 'PUT', '/api/approvals/mode', { away: true })).status).toBe(200);
    expect(await (await call('u1', 'GET', '/api/approvals/mode')).json()).toEqual({ away: true });
    expect(await (await call('u2', 'GET', '/api/approvals/mode')).json()).toEqual({ away: false });
    expect((await call('u1', 'PUT', '/api/approvals/mode', { away: 'yes' })).status).toBe(400);
  });
});

describe('approval request → decision', () => {
  it('PC posts, waits for the phone-signed decision and verifies the signature', async () => {
    const { id, res } = await newRequest();
    expect(res.status).toBe(201);
    expect((await (await call('u1', 'GET', '/api/approvals')).json()).map((a: { id: string }) => a.id)).toEqual([id]);

    // phone decides while the PC is waiting
    const waiting = call('u1', 'GET', `/api/approvals/${id}/wait?ms=5000`);
    await new Promise((r) => setTimeout(r, 50));
    const sig = await signDecision(keys, id, 'allow');
    expect((await call('u1', 'POST', `/api/approvals/${id}/decide`, { decision: 'allow', sig })).status).toBe(200);
    const got = await (await waiting).json();
    expect(got).toMatchObject({ id, status: 'allow', sig });
    expect(await verifyDecision(keys, id, got.status, got.sig)).toBe(true);
    // once decided, it drops out of the list
    expect(await (await call('u1', 'GET', '/api/approvals')).json()).toEqual([]);
  });

  it('first decision only — the second gets 409', async () => {
    const { id } = await newRequest();
    await call('u1', 'POST', `/api/approvals/${id}/decide`, { decision: 'deny', sig: await signDecision(keys, id, 'deny') });
    const again = await call('u1', 'POST', `/api/approvals/${id}/decide`, { decision: 'allow', sig: await signDecision(keys, id, 'allow') });
    expect(again.status).toBe(409);
    expect((await (await call('u1', 'GET', `/api/approvals/${id}`)).json()).status).toBe('deny');
  });

  it('other accounts can neither see nor decide', async () => {
    const { id } = await newRequest('u1');
    expect((await call('u2', 'GET', `/api/approvals/${id}`)).status).toBe(404);
    expect(await (await call('u2', 'GET', '/api/approvals')).json()).toEqual([]);
    const sig = await signDecision(keys, id, 'allow');
    expect((await call('u2', 'POST', `/api/approvals/${id}/decide`, { decision: 'allow', sig })).status).toBe(404);
  });

  it('returns pending as is when the wait times out (the PC asks again)', async () => {
    const { id } = await newRequest();
    const t = Date.now();
    expect(await (await call('u1', 'GET', `/api/approvals/${id}/wait?ms=200`)).json()).toMatchObject({ status: 'pending' });
    expect(Date.now() - t).toBeGreaterThanOrEqual(150);
  });

  it('no decision is accepted once the PC stops waiting (cancel)', async () => {
    const { id } = await newRequest();
    expect((await (await call('u1', 'POST', `/api/approvals/${id}/cancel`)).json()).status).toBe('cancelled');
    const sig = await signDecision(keys, id, 'allow');
    expect((await call('u1', 'POST', `/api/approvals/${id}/decide`, { decision: 'allow', sig })).status).toBe(409);
  });

  it('once expired, decisions are rejected and sweep marks it expired', async () => {
    const { id } = await newRequest('u1', 10);
    const later = new Date(Date.now() + 11_000);
    expect(await approvals.settle('u1', id, 'allow', 'x'.repeat(43), later)).toBeUndefined();
    expect(await approvals.sweep(later)).toBe(1);
    expect((await approvals.get('u1', id))?.status).toBe('expired');
  });

  it.each([
    ['plaintext request', { request: 'rm -rf dist' }],
    ['id format', { id: 'short' }],
    ['no ttl', { ttlSec: undefined }],
  ])('rejects invalid request: %s', async (_, patch) => {
    const id = newApprovalId();
    const request = await sealApprovalRequest(keys, id, describeToolRequest('Bash', { command: 'ls' }));
    const res = await call('u1', 'POST', '/api/approvals', { id, sessionKey: 'k', request, ttlSec: 60, ...patch });
    expect(res.status).toBe(400);
  });

  it('rejects a decision whose signature is malformed', async () => {
    const { id } = await newRequest();
    expect((await call('u1', 'POST', `/api/approvals/${id}/decide`, { decision: 'allow', sig: 'nope' })).status).toBe(400);
    expect((await call('u1', 'POST', `/api/approvals/${id}/decide`, { decision: 'yes', sig: 'A'.repeat(43) })).status).toBe(400);
  });
});

describe('when answered in the terminal first', () => {
  const hook = (event: string, extra: Record<string, unknown> = {}) =>
    wire({ source: 'claude-code', receivedAt: new Date().toISOString(), payload: { session_id: 's1', cwd: 'C:/work/api', hook_event_name: event, ...extra } }).then(
      (rec) => store.ingest('u1', rec),
    );

  it('closes leftover approval requests when the card leaves waiting for you', async () => {
    const off = closeApprovalsOnResume(store, approvals);
    await hook('UserPromptSubmit', { prompt: '배포' });
    await hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } });
    const { id } = await newRequest('u1');
    // other cards' requests are untouched
    const other = newApprovalId();
    await approvals.create('u1', { id: other, sessionKey: 'claude-code:s2', request: (await newRequest('u1')).request, ttlMs: 60_000 });
    // allowed in the terminal → tool finished
    await hook('PostToolUse', { tool_name: 'Bash' });
    await new Promise((r) => setTimeout(r, 50));
    off();
    expect((await approvals.get('u1', id))?.status).toBe('cancelled');
    expect((await approvals.get('u1', other))?.status).toBe('pending');
  });
});

describe('approval request notifications', () => {
  it('sends each new request to the devices of that account (sealed request included)', async () => {
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

  it('sends a cleanup notification to the same devices when it ends (same topic — replaces an undelivered request notification)', async () => {
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
