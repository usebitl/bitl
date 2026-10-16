import { open } from '@bitl/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { type PushPayload, type PushSender, type SendResult, startPushNotifier } from '../src/push.js';
import { PushStore, type PushSubscriptionRow, openSqliteStore, type SqlStore } from '../src/store/index.js';
import { keys, wire } from './helpers.js';

let store: SqlStore;
let push: PushStore;
let sent: { sub: PushSubscriptionRow; payload: PushPayload; topic: string }[];
let reply: SendResult;
let notifier: ReturnType<typeof startPushNotifier>;

const sender: PushSender = async (sub, payload, topic) => {
  sent.push({ sub, payload: JSON.parse(payload) as PushPayload, topic });
  return reply;
};

const sub = (n: number) => ({
  endpoint: `https://push.example.com/send/${n}`,
  p256dh: 'B'.repeat(87),
  auth: 'a'.repeat(22),
});

const hook = (account: string, sessionId: string, event: string, extra: Record<string, unknown> = {}) =>
  wire({
    source: 'claude-code',
    receivedAt: new Date().toISOString(),
    payload: { session_id: sessionId, cwd: 'C:/work/api', hook_event_name: event, ...extra },
  }).then((rec) => store.ingest(account, rec));

const ask = async (account: string, sessionId: string) => {
  await hook(account, sessionId, 'UserPromptSubmit', { prompt: '배포 스크립트 고쳐줘' });
  await hook(account, sessionId, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } });
  await hook(account, sessionId, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } });
  await notifier.idle();
};

beforeEach(() => {
  store = openSqliteStore(':memory:');
  push = new PushStore(store.db);
  sent = [];
  reply = 'ok';
  notifier = startPushNotifier({ store, push, sender, cooldownMs: 0 });
});
afterEach(async () => {
  notifier.stop();
  await store.close();
});

describe('waiting-for-you notifications', () => {
  it('pushes to the subscribed devices of the account the moment a card turns waiting for you — content is ciphertext, opened with the device key', async () => {
    await push.subscribe('u1', sub(1));
    await ask('u1', 's1');
    expect(sent).toHaveLength(1);
    const { payload, topic, sub: to } = sent[0]!;
    expect(to.endpoint).toBe(sub(1).endpoint);
    expect(payload).toMatchObject({ v: 1, key: 'claude-code:s1', status: 'waiting_for_you', reason: 'permission', attention: 1 });
    expect(topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    // the server only carried ciphertext
    expect(JSON.stringify(payload)).not.toContain('rm -rf');
    expect(await open(keys, payload.sealed.activity!, payload.key)).toBe('Bash: rm -rf dist');
    expect(await open(keys, payload.sealed.title!, payload.key)).toBe('배포 스크립트 고쳐줘');
  });

  it('does not resend while the status is unchanged (even if more events arrive while waiting)', async () => {
    await push.subscribe('u1', sub(1));
    await ask('u1', 's1');
    await hook('u1', 's1', 'Notification', { message: '권한이 필요합니다' });
    await notifier.idle();
    expect(sent).toHaveLength(1);
  });

  it('skips a session that never got a prompt (relaying notifications about other sessions) and leaves it out of the count', async () => {
    await push.subscribe('u1', sub(1));
    await hook('u1', 'relay', 'Notification', { notification_type: 'agent_needs_input', message: 'other-task needs your input' });
    await notifier.idle();
    expect(sent).toHaveLength(0);
    await ask('u1', 's1');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload).toMatchObject({ key: 'claude-code:s1', attention: 1 });
  });

  it('never goes to devices of another account', async () => {
    await push.subscribe('u1', sub(1));
    await push.subscribe('u2', sub(2));
    await ask('u2', 's1');
    expect(sent.map((s) => s.sub.endpoint)).toEqual([sub(2).endpoint]);
  });

  it('only once per card within the cooldown', async () => {
    notifier.stop();
    notifier = startPushNotifier({ store, push, sender, cooldownMs: 60_000 });
    await push.subscribe('u1', sub(1));
    await ask('u1', 's1');
    await hook('u1', 's1', 'PostToolUse', { tool_name: 'Bash' });
    await ask('u1', 's1');
    expect(sent).toHaveLength(1);
    // other cards are separate
    await ask('u1', 's2');
    expect(sent).toHaveLength(2);
    expect(sent[1]!.payload.attention).toBe(2);
  });

  it('deletes the subscription on a gone response (410)', async () => {
    await push.subscribe('u1', sub(1));
    reply = 'gone';
    await ask('u1', 's1');
    expect(await push.list('u1')).toEqual([]);
  });

  it('transient failures delete only after several', async () => {
    await push.subscribe('u1', sub(1));
    reply = 'failed';
    for (let i = 1; i <= 4; i++) await ask('u1', `s${i}`);
    expect(await push.list('u1')).toHaveLength(1);
    await ask('u1', 's5');
    expect(await push.list('u1')).toEqual([]);
  });
});

describe('push subscription API', () => {
  const PUBLIC_KEY = 'BPublicKeyForTest';
  const app = () => createApp({ store, account: (c) => c.req.header('x-account') ?? null, push: { store: push, publicKey: PUBLIC_KEY } });
  const post = (account: string, path: string, body: unknown) =>
    app().request(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-account': account } });
  const subscription = (n: number) => ({ endpoint: sub(n).endpoint, keys: { p256dh: sub(n).p256dh, auth: sub(n).auth } });

  it('public key needs no login; null when push is disabled', async () => {
    expect(await (await app().request('/api/push/key')).json()).toEqual({ publicKey: PUBLIC_KEY });
    expect(await (await createApp({ store }).request('/api/push/key')).json()).toEqual({ publicKey: null });
  });

  it('subscribe → check status → unsubscribe', async () => {
    expect((await post('u1', '/api/push/subscribe', subscription(1))).status).toBe(200);
    expect(await (await post('u1', '/api/push/status', { endpoint: sub(1).endpoint })).json()).toEqual({ subscribed: true });
    // another account can neither see nor delete it
    expect(await (await post('u2', '/api/push/status', { endpoint: sub(1).endpoint })).json()).toEqual({ subscribed: false });
    expect(await (await post('u2', '/api/push/unsubscribe', { endpoint: sub(1).endpoint })).json()).toEqual({ ok: false });
    expect(await (await post('u1', '/api/push/unsubscribe', { endpoint: sub(1).endpoint })).json()).toEqual({ ok: true });
    expect(await push.list('u1')).toEqual([]);
  });

  it('resubscribing the same browser under another account moves it to that account', async () => {
    await post('u1', '/api/push/subscribe', subscription(1));
    await post('u2', '/api/push/subscribe', subscription(1));
    expect(await push.list('u1')).toEqual([]);
    expect(await push.list('u2')).toHaveLength(1);
  });

  it('cannot subscribe without login', async () => {
    const res = await app().request('/api/push/subscribe', { method: 'POST', body: JSON.stringify(subscription(1)) });
    expect(res.status).toBe(401);
  });

  it.each([
    ['non-https URL', { ...subscription(1), endpoint: 'http://push.example.com/x' }],
    ['not a URL', { ...subscription(1), endpoint: 'not a url' }],
    ['no keys', { endpoint: sub(1).endpoint }],
    ['malformed keys', { endpoint: sub(1).endpoint, keys: { p256dh: 'short', auth: 'a'.repeat(22) } }],
  ])('rejects invalid subscription: %s', async (_, body) => {
    expect((await post('u1', '/api/push/subscribe', body)).status).toBe(400);
  });
});
