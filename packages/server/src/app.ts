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
 * Which account a request belongs to. null means 401.
 * Local mode always uses the local account. Other methods (login, device key) are decided by the extension (AppExtension.resolveAccount).
 */
export type AccountResolver = (c: Context) => string | null | Promise<string | null>;

/** deviceId: request authenticated with a device API key (collector, CLI) */
export type AppEnv = { Variables: { accountId: string; deviceId?: string } };
type Env = AppEnv;
export type AppHono = Hono<AppEnv>;

/**
 * Extension point for adding server features (login, device pairing, billing, etc.). Unused in local mode.
 * Order: /api/me → mountPublic → account check (resolveAccount) → mountAccount → board API → mountPages → web files
 */
export interface AppExtension {
  /** /api/me response. Defaults to { mode: 'local' } */
  me?: (c: Context) => unknown;
  /** Routes mounted before the account check (login, origin check, webhooks …) */
  mountPublic?: (app: AppHono) => void;
  /** The request's account. null means 401 */
  resolveAccount?: (c: Context) => Promise<{ accountId: string; deviceId?: string } | null>;
  /** APIs that work only within an account */
  mountAccount?: (app: AppHono) => void;
  /** Web page routes (before the built web files). html(file): contents of an HTML file from the web build */
  mountPages?: (app: AppHono, html: (file: string) => string) => void;
}

export interface AppOptions {
  store: SessionStore;
  /** Path to the built web UI (packages/web/dist). Without it, only the API is served */
  webDist?: string;
  /** Overrides account resolution (for tests). Defaults to the local account */
  account?: AccountResolver;
  /** Web push (when VAPID keys are configured) */
  push?: { store: PushStore; publicKey: string };
  /** Remote approval (allow/deny from a phone) */
  approvals?: ApprovalStore;
  /** Goals (group several cards under a purpose the user defines) */
  goals?: GoalStore;
  /** Whether the account may write new data. Defaults to always */
  access?: AccessPolicy;
  extension?: AppExtension;
  /** Which build is running (e.g. the git commit), returned by /api/health so a deploy can be checked */
  build?: string;
}


/**
 * Applies a record sent by an adapter (v2: signal + ciphertext). null if malformed.
 * Rejects plaintext content or the old format (raw payload), so no plaintext ends up in the server DB.
 */
export async function ingestRecord(store: SessionStore, accountId: string, body: unknown): Promise<StoredSession | null> {
  const rec = parseWireRecord(body);
  return rec ? store.ingest(accountId, rec) : null;
}

export function createApp({ store, webDist, account, push, approvals, goals, access = allowAll, extension, build }: AppOptions) {
  const app = new Hono<Env>();
  const resolve: AccountResolver = account ?? (() => LOCAL_ACCOUNT);

  app.get('/api/health', (c) => c.json(build ? { ok: true, build } : { ok: true }));

  // The web app asks first: is this local mode (with an extension: login state, etc.)
  app.get('/api/me', async (c) => c.json(extension?.me ? await extension.me(c) : { mode: 'local' }));

  extension?.mountPublic?.(app);

  // Web push public key (VAPID) — public info. null means notifications are disabled on this server
  app.get('/api/push/key', (c) => c.json({ publicKey: push?.publicKey ?? null }));

  // Every API below works only within an account
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
    // Read-only (trial/subscription ended): drop it. Answer 200 so the adapter doesn't queue it (and old events don't flood in after payment)
    if (!(await access.canWrite(c.var.accountId))) return c.json({ ok: true, accepted: false, reason: 'subscription_required' });
    const s = await ingestRecord(store, c.var.accountId, body);
    // Even for unknown formats, don't return an error to the agent side (so the adapter doesn't queue forever)
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

  // Accept only user-editable fields: note (encrypted by the browser, '' clears it), pin
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

  // Delete a card the user no longer wants on the board, along with its history
  app.delete('/api/sessions/:key', async (c) =>
    (await store.deleteSession(c.var.accountId, c.req.param('key'))) ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404),
  );

  // Bulk-delete ended cards {keys?} — with keys, only the ended ones among them ("Clear all" on a goal-filtered view)
  app.post('/api/sessions/delete-ended', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { keys?: unknown };
    const keys = Array.isArray(body?.keys) ? body.keys.filter((k): k is string => typeof k === 'string').slice(0, 5000) : undefined;
    return c.json({ deleted: await store.deleteEnded(c.var.accountId, keys) });
  });

  // "Clear board" {goals?}: deletes ended cards, sweeps the rest off until their agent acts again, and with goals deletes every goal too
  app.post('/api/board/clear', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { goals?: unknown };
    const result = await store.clearBoard(c.var.accountId);
    let goalsDeleted = 0;
    if (body?.goals === true && goals) {
      for (const g of await goals.list(c.var.accountId, true)) if (await goals.delete(c.var.accountId, g.id)) goalsDeleted++;
    }
    return c.json({ ...result, goals: goalsDeleted });
  });

  app.post('/api/sessions/:key/ack', async (c) => found(c, await store.acknowledge(c.var.accountId, c.req.param('key'))));
  app.post('/api/sessions/:key/archive', async (c) =>
    found(c, await store.editSession(c.var.accountId, c.req.param('key'), { archived: true })),
  );
  app.post('/api/sessions/:key/unarchive', async (c) =>
    found(c, await store.editSession(c.var.accountId, c.req.param('key'), { archived: false })),
  );

  // Live: one snapshot on connect, then a session event for each changed session in this account
  app.get('/api/stream', (c) => {
    const accountId = c.var.accountId;
    return streamSSE(c, async (stream) => {
      const queue: (StoreChange | ({ type: 'approval' } & ApprovalChange) | GoalChange)[] = [];
      let wake: (() => void) | undefined;
      // Subscribe first so changes made while reading the snapshot aren't missed
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
      // Remote approval: pending requests (then an approval event on every change)
      if (approvals) await stream.writeSSE({ event: 'approvals', data: JSON.stringify(await approvals.listPending(accountId)) });
      // Goals: open goals (then goal · goal-removed events)
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
    // The service worker must pick up a new version right after a deploy (bypass the browser cache)
    app.use('/sw.js', async (c, next) => {
      await next();
      c.header('Cache-Control', 'no-cache');
    });
    // Read every time so a web rebuild takes effect without a server restart. Older builds (no app.html) use index.html
    const html = (file: string) => {
      const path = join(webDist, file);
      return readFileSync(existsSync(path) ? path : join(webDist, 'index.html'), 'utf8');
    };
    extension?.mountPages?.(app, html);
    app.use('/*', serveStatic({ root: webDist }));
    // Any other path gets the app shell
    app.get('*', (c) => c.html(html('app.html')));
  }

  return app;
}

/** Receive notifications in this browser — the body is PushSubscription.toJSON() as is */
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
    // p256dh: P-256 public key, 65 bytes (87 chars); auth: 16 bytes (22 chars)
    if (!endpoint || !text(p256dh, 80, 100) || !text(auth, 16, 32)) return c.json({ error: 'invalid subscription' }, 400);
    await push.subscribe(c.var.accountId, { endpoint, p256dh, auth });
    return c.json({ ok: true });
  });
  app.post('/api/push/unsubscribe', async (c) => {
    const endpoint = endpointOf((await body(c)).endpoint);
    if (!endpoint) return c.json({ error: 'invalid endpoint' }, 400);
    return c.json({ ok: await push.unsubscribe(c.var.accountId, endpoint) });
  });
  // Whether this browser is subscribed for this account (for the notification toggle)
  app.post('/api/push/status', async (c) => {
    const endpoint = endpointOf((await body(c)).endpoint);
    return c.json({ subscribed: endpoint ? await push.has(c.var.accountId, endpoint) : false });
  });
}
