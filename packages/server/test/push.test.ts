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

describe('나를 기다림 알림', () => {
  it('나를 기다림으로 바뀌는 순간 그 계정의 구독 기기로 보낸다 — 내용은 암호문, 기기 키로 풀린다', async () => {
    await push.subscribe('u1', sub(1));
    await ask('u1', 's1');
    expect(sent).toHaveLength(1);
    const { payload, topic, sub: to } = sent[0]!;
    expect(to.endpoint).toBe(sub(1).endpoint);
    expect(payload).toMatchObject({ v: 1, key: 'claude-code:s1', status: 'waiting_for_you', reason: 'permission', attention: 1 });
    expect(topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    // 서버가 실은 것은 암호문뿐
    expect(JSON.stringify(payload)).not.toContain('rm -rf');
    expect(await open(keys, payload.sealed.activity!, payload.key)).toBe('Bash: rm -rf dist');
    expect(await open(keys, payload.sealed.title!, payload.key)).toBe('배포 스크립트 고쳐줘');
  });

  it('상태가 그대로면(대기 중 이벤트가 더 와도) 다시 보내지 않는다', async () => {
    await push.subscribe('u1', sub(1));
    await ask('u1', 's1');
    await hook('u1', 's1', 'Notification', { message: '권한이 필요합니다' });
    await notifier.idle();
    expect(sent).toHaveLength(1);
  });

  it('다른 계정의 기기로는 가지 않는다', async () => {
    await push.subscribe('u1', sub(1));
    await push.subscribe('u2', sub(2));
    await ask('u2', 's1');
    expect(sent.map((s) => s.sub.endpoint)).toEqual([sub(2).endpoint]);
  });

  it('쿨다운 안에서는 같은 카드에 한 번만', async () => {
    notifier.stop();
    notifier = startPushNotifier({ store, push, sender, cooldownMs: 60_000 });
    await push.subscribe('u1', sub(1));
    await ask('u1', 's1');
    await hook('u1', 's1', 'PostToolUse', { tool_name: 'Bash' });
    await ask('u1', 's1');
    expect(sent).toHaveLength(1);
    // 다른 카드는 따로
    await ask('u1', 's2');
    expect(sent).toHaveLength(2);
    expect(sent[1]!.payload.attention).toBe(2);
  });

  it('구독이 없어졌다는 응답(410)이면 구독을 지운다', async () => {
    await push.subscribe('u1', sub(1));
    reply = 'gone';
    await ask('u1', 's1');
    expect(await push.list('u1')).toEqual([]);
  });

  it('일시적 실패는 여러 번 쌓여야 지운다', async () => {
    await push.subscribe('u1', sub(1));
    reply = 'failed';
    for (let i = 1; i <= 4; i++) await ask('u1', `s${i}`);
    expect(await push.list('u1')).toHaveLength(1);
    await ask('u1', 's5');
    expect(await push.list('u1')).toEqual([]);
  });
});

describe('푸시 구독 API', () => {
  const PUBLIC_KEY = 'BPublicKeyForTest';
  const app = () => createApp({ store, account: (c) => c.req.header('x-account') ?? null, push: { store: push, publicKey: PUBLIC_KEY } });
  const post = (account: string, path: string, body: unknown) =>
    app().request(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-account': account } });
  const subscription = (n: number) => ({ endpoint: sub(n).endpoint, keys: { p256dh: sub(n).p256dh, auth: sub(n).auth } });

  it('공개키는 로그인 없이 받는다. 푸시가 꺼진 서버는 null', async () => {
    expect(await (await app().request('/api/push/key')).json()).toEqual({ publicKey: PUBLIC_KEY });
    expect(await (await createApp({ store }).request('/api/push/key')).json()).toEqual({ publicKey: null });
  });

  it('구독 → 상태 확인 → 해지', async () => {
    expect((await post('u1', '/api/push/subscribe', subscription(1))).status).toBe(200);
    expect(await (await post('u1', '/api/push/status', { endpoint: sub(1).endpoint })).json()).toEqual({ subscribed: true });
    // 다른 계정에서는 안 보이고 지울 수도 없다
    expect(await (await post('u2', '/api/push/status', { endpoint: sub(1).endpoint })).json()).toEqual({ subscribed: false });
    expect(await (await post('u2', '/api/push/unsubscribe', { endpoint: sub(1).endpoint })).json()).toEqual({ ok: false });
    expect(await (await post('u1', '/api/push/unsubscribe', { endpoint: sub(1).endpoint })).json()).toEqual({ ok: true });
    expect(await push.list('u1')).toEqual([]);
  });

  it('같은 브라우저가 다른 계정으로 다시 구독하면 그 계정 것이 된다', async () => {
    await post('u1', '/api/push/subscribe', subscription(1));
    await post('u2', '/api/push/subscribe', subscription(1));
    expect(await push.list('u1')).toEqual([]);
    expect(await push.list('u2')).toHaveLength(1);
  });

  it('로그인 없이는 구독할 수 없다', async () => {
    const res = await app().request('/api/push/subscribe', { method: 'POST', body: JSON.stringify(subscription(1)) });
    expect(res.status).toBe(401);
  });

  it.each([
    ['https 가 아닌 주소', { ...subscription(1), endpoint: 'http://push.example.com/x' }],
    ['주소 아님', { ...subscription(1), endpoint: 'not a url' }],
    ['키 없음', { endpoint: sub(1).endpoint }],
    ['키 형식 틀림', { endpoint: sub(1).endpoint, keys: { p256dh: 'short', auth: 'a'.repeat(22) } }],
  ])('잘못된 구독은 거절: %s', async (_, body) => {
    expect((await post('u1', '/api/push/subscribe', body)).status).toBe(400);
  });
});
