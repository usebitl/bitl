import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { type Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { parseWireRecord, SealedValue, type StoredSession } from '@bitl/shared';
import { type AccessPolicy, allowAll } from './access.js';
import { mountApprovals } from './approvals-api.js';
import { mountGoals } from './goals-api.js';
import { type ApprovalChange, type ApprovalStore, type GoalChange, type GoalStore, LOCAL_ACCOUNT, type PushStore, type SessionEdit, type SessionStore, type StoreChange } from './store/index.js';

/**
 * 요청이 어느 계정 것인지. null 이면 401.
 * 로컬 모드는 늘 로컬 계정이다. 다른 방식(로그인·기기 키)은 확장(AppExtension.resolveAccount)이 정한다.
 */
export type AccountResolver = (c: Context) => string | null | Promise<string | null>;

/** deviceId: 기기 API 키로 들어온 요청 (수집기·CLI) */
export type AppEnv = { Variables: { accountId: string; deviceId?: string } };
type Env = AppEnv;
export type AppHono = Hono<AppEnv>;

/**
 * 서버에 기능을 더하는 자리 (로그인·기기 연결·요금제 같은 것). 로컬 모드는 쓰지 않는다.
 * 순서: /api/me → mountPublic → 계정 확인(resolveAccount) → mountAccount → 보드 API → mountPages → 웹 파일
 */
export interface AppExtension {
  /** /api/me 응답. 없으면 { mode: 'local' } */
  me?: (c: Context) => unknown;
  /** 계정을 확인하기 전에 여는 것 (로그인, 요청 출처 검사, 웹훅 …) */
  mountPublic?: (app: AppHono) => void;
  /** 요청의 계정. null 이면 401 */
  resolveAccount?: (c: Context) => Promise<{ accountId: string; deviceId?: string } | null>;
  /** 계정 안에서만 동작하는 API */
  mountAccount?: (app: AppHono) => void;
  /** 웹 페이지 주소 (빌드된 웹 파일보다 먼저). html(file): 빌드된 웹의 HTML 파일 내용 */
  mountPages?: (app: AppHono, html: (file: string) => string) => void;
}

export interface AppOptions {
  store: SessionStore;
  /** 빌드된 웹 UI 경로 (packages/web/dist). 없으면 API 만 제공 */
  webDist?: string;
  /** 계정 해석을 직접 정한다 (테스트용). 없으면 로컬 계정 */
  account?: AccountResolver;
  /** 웹 푸시 (VAPID 키가 설정됐을 때) */
  push?: { store: PushStore; publicKey: string };
  /** 원격 승인 (폰에서 허용·거부) */
  approvals?: ApprovalStore;
  /** 목표 (여러 카드를 사람이 정한 목적으로 묶음) */
  goals?: GoalStore;
  /** 새로 쓸 수 있는 계정인가. 없으면 늘 쓸 수 있다 */
  access?: AccessPolicy;
  extension?: AppExtension;
}


/**
 * 어댑터가 보낸 레코드(v2: 신호 + 암호문)를 반영한다. 형식이 틀리면 null.
 * 내용이 평문이거나 옛 형식(원본 페이로드)이면 받지 않는다 — 서버 DB 에 평문이 남지 않게.
 */
export async function ingestRecord(store: SessionStore, accountId: string, body: unknown): Promise<StoredSession | null> {
  const rec = parseWireRecord(body);
  return rec ? store.ingest(accountId, rec) : null;
}

export function createApp({ store, webDist, account, push, approvals, goals, access = allowAll, extension }: AppOptions) {
  const app = new Hono<Env>();
  const resolve: AccountResolver = account ?? (() => LOCAL_ACCOUNT);

  app.get('/api/health', (c) => c.json({ ok: true }));

  // 웹이 처음에 묻는다: 로컬 모드인가 (확장이 있으면 로그인 상태 등)
  app.get('/api/me', async (c) => c.json(extension?.me ? await extension.me(c) : { mode: 'local' }));

  extension?.mountPublic?.(app);

  // 웹 푸시 공개키 (VAPID) — 공개 정보. null 이면 알림 기능이 꺼진 서버
  app.get('/api/push/key', (c) => c.json({ publicKey: push?.publicKey ?? null }));

  // 이 아래의 API 는 모두 계정 안에서만 동작한다
  app.use('/api/*', async (c, next) => {
    if (extension?.resolveAccount) {
      const who = await extension.resolveAccount(c);
      if (!who) return c.json({ error: 'unauthorized' }, 401);
      c.set('accountId', who.accountId);
      if (who.deviceId) c.set('deviceId', who.deviceId);
      return next();
    }
    const id = await resolve(c);
    if (!id) return c.json({ error: 'unauthorized' }, 401);
    c.set('accountId', id);
    await next();
  });

  extension?.mountAccount?.(app);
  if (push) mountPush(app, push.store);
  if (approvals) mountApprovals(app, approvals, access);
  if (goals) mountGoals(app, goals, access);

  app.post('/api/events', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid json' }, 400);
    }
    // 읽기 전용(체험·구독 끝남): 받지 않는다. 200 으로 답해 어댑터가 큐에 쌓아 두지 않게 (결제 후 옛 이벤트가 몰려오지 않게)
    if (!(await access.canWrite(c.var.accountId))) return c.json({ ok: true, accepted: false, reason: 'subscription_required' });
    const s = await ingestRecord(store, c.var.accountId, body);
    // 모르는 형식이어도 에이전트 쪽에 오류를 돌려주지 않는다 (어댑터가 큐에 무한히 쌓지 않게)
    return c.json({ ok: true, accepted: Boolean(s), key: s?.key });
  });

  app.get('/api/sessions', async (c) =>
    c.json(
      await store.listSessions(c.var.accountId, {
        includeEnded: c.req.query('ended') === '1',
        includeArchived: c.req.query('archived') === '1',
      }),
    ),
  );

  app.get('/api/sessions/:key', async (c) => {
    const [accountId, key] = [c.var.accountId, c.req.param('key')];
    const session = await store.getSession(accountId, key);
    if (!session) return c.json({ error: 'not found' }, 404);
    const [turns, timeline] = await Promise.all([store.listTurns(accountId, key), store.listTimeline(accountId, key)]);
    return c.json({ session, turns, timeline });
  });

  const found = (c: Context<Env>, s: StoredSession | undefined) => (s ? c.json(s) : c.json({ error: 'not found' }, 404));

  // 사용자가 편집할 수 있는 필드만 받는다: 메모(브라우저가 암호화한 값, '' 는 지움), 핀
  app.patch('/api/sessions/:key', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { note?: unknown; pinned?: unknown } | null;
    if (!body || typeof body !== 'object') return c.json({ error: 'invalid body' }, 400);
    const edit: SessionEdit = {};
    if (body.note === '') edit.note = null;
    else if (body.note !== undefined) {
      const note = SealedValue.safeParse(body.note);
      if (!note.success) return c.json({ error: 'note must be sealed' }, 400);
      edit.note = note.data;
    }
    if (typeof body.pinned === 'boolean') edit.pinned = body.pinned;
    return found(c, await store.editSession(c.var.accountId, c.req.param('key'), edit));
  });

  // 현황판에서 보고 싶지 않은 카드를 기록째 지운다
  app.delete('/api/sessions/:key', async (c) =>
    (await store.deleteSession(c.var.accountId, c.req.param('key'))) ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404),
  );

  // 종료된 카드 일괄 삭제 {keys?} — keys 를 주면 그중 종료된 것만 (목표로 거른 화면의 "모두 지우기")
  app.post('/api/sessions/delete-ended', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { keys?: unknown };
    const keys = Array.isArray(body?.keys) ? body.keys.filter((k): k is string => typeof k === 'string').slice(0, 5000) : undefined;
    return c.json({ deleted: await store.deleteEnded(c.var.accountId, keys) });
  });

  app.post('/api/sessions/:key/ack', async (c) => found(c, await store.acknowledge(c.var.accountId, c.req.param('key'))));
  app.post('/api/sessions/:key/archive', async (c) =>
    found(c, await store.editSession(c.var.accountId, c.req.param('key'), { archived: true })),
  );
  app.post('/api/sessions/:key/unarchive', async (c) =>
    found(c, await store.editSession(c.var.accountId, c.req.param('key'), { archived: false })),
  );

  // 실시간: 연결 시 snapshot 한 번, 이후 이 계정의 바뀐 세션마다 session 이벤트
  app.get('/api/stream', (c) => {
    const accountId = c.var.accountId;
    return streamSSE(c, async (stream) => {
      const queue: (StoreChange | ({ type: 'approval' } & ApprovalChange) | GoalChange)[] = [];
      let wake: (() => void) | undefined;
      // snapshot 을 읽는 동안 생긴 변화도 놓치지 않도록 먼저 구독한다
      const offSessions = store.subscribe((change) => {
        if (change.accountId !== accountId) return;
        queue.push(change);
        wake?.();
      });
      const offApprovals = approvals?.subscribe((change) => {
        if (change.accountId !== accountId) return;
        queue.push({ type: 'approval', ...change });
        wake?.();
      });
      const offGoals = goals?.subscribe((change) => {
        if (change.accountId !== accountId) return;
        queue.push(change);
        wake?.();
      });
      const unsubscribe = () => {
        offSessions();
        offApprovals?.();
        offGoals?.();
      };
      stream.onAbort(() => {
        unsubscribe();
        wake?.();
      });

      await stream.writeSSE({ event: 'snapshot', data: JSON.stringify(await store.listSessions(accountId, { includeEnded: true })) });
      // 원격 승인: 기다리는 요청 목록 (이후 바뀔 때마다 approval 이벤트)
      if (approvals) await stream.writeSSE({ event: 'approvals', data: JSON.stringify(await approvals.listPending(accountId)) });
      // 목표: 마치지 않은 목표 목록 (이후 goal · goal-removed 이벤트)
      if (goals) await stream.writeSSE({ event: 'goals', data: JSON.stringify(await goals.list(accountId)) });
      while (!stream.aborted) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
            setTimeout(resolve, 25_000); // keep-alive
          });
          wake = undefined;
          if (queue.length === 0 && !stream.aborted) await stream.writeSSE({ event: 'ping', data: '' });
          continue;
        }
        const change = queue.shift()!;
        await stream.writeSSE(
          change.type === 'session'
            ? { event: 'session', data: JSON.stringify(change.session) }
            : change.type === 'approval'
              ? { event: 'approval', data: JSON.stringify(change.approval) }
              : change.type === 'goal'
                ? { event: 'goal', data: JSON.stringify(change.goal) }
                : change.type === 'goal-removed'
                  ? { event: 'goal-removed', data: JSON.stringify({ id: change.id }) }
                  : { event: 'removed', data: JSON.stringify({ key: change.key }) },
        );
      }
      unsubscribe();
    });
  });

  if (webDist && existsSync(webDist)) {
    // 서비스 워커는 배포하면 바로 새 버전을 받아야 한다 (브라우저 캐시를 거치지 않게)
    app.use('/sw.js', async (c, next) => {
      await next();
      c.header('Cache-Control', 'no-cache');
    });
    // 웹을 다시 빌드해도 서버 재시작 없이 반영되도록 매번 읽는다. 옛 빌드(app.html 없음)면 index.html
    const html = (file: string) => {
      const path = join(webDist, file);
      return readFileSync(existsSync(path) ? path : join(webDist, 'index.html'), 'utf8');
    };
    extension?.mountPages?.(app, html);
    app.use('/*', serveStatic({ root: webDist }));
    // 그 밖의 주소는 앱 껍데기
    app.get('*', (c) => c.html(html('app.html')));
  }

  return app;
}

/** 이 브라우저에서 알림 받기 — 본문은 PushSubscription.toJSON() 그대로 */
function mountPush(app: Hono<Env>, push: PushStore) {
  const B64URL = /^[A-Za-z0-9_-]+$/;
  const text = (v: unknown, min: number, max: number): v is string =>
    typeof v === 'string' && v.length >= min && v.length <= max && B64URL.test(v);
  const endpointOf = (v: unknown) => {
    if (typeof v !== 'string' || v.length > 1000) return undefined;
    try {
      return new URL(v).protocol === 'https:' ? v : undefined;
    } catch {
      return undefined;
    }
  };
  const body = async (c: Context) => ((await c.req.json().catch(() => null)) ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };

  app.post('/api/push/subscribe', async (c) => {
    const b = await body(c);
    const endpoint = endpointOf(b.endpoint);
    const { p256dh, auth } = b.keys ?? {};
    // p256dh: P-256 공개키 65바이트(87자), auth: 16바이트(22자)
    if (!endpoint || !text(p256dh, 80, 100) || !text(auth, 16, 32)) return c.json({ error: 'invalid subscription' }, 400);
    await push.subscribe(c.var.accountId, { endpoint, p256dh, auth });
    return c.json({ ok: true });
  });
  app.post('/api/push/unsubscribe', async (c) => {
    const endpoint = endpointOf((await body(c)).endpoint);
    if (!endpoint) return c.json({ error: 'invalid endpoint' }, 400);
    return c.json({ ok: await push.unsubscribe(c.var.accountId, endpoint) });
  });
  // 이 브라우저가 이 계정으로 구독돼 있는지 (알림 스위치 표시용)
  app.post('/api/push/status', async (c) => {
    const endpoint = endpointOf((await body(c)).endpoint);
    return c.json({ subscribed: endpoint ? await push.has(c.var.accountId, endpoint) : false });
  });
}
