import { existsSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { type CliUpdate, checkCliUpdate } from '@bitl/shared/node';
import { type AccessPolicy, allowAll } from './access.js';
import { closeApprovalsOnResume } from './approvals-api.js';
import { createApp, ingestRecord } from './app.js';
import { startPushNotifier, webPushSender } from './push.js';
import { ApprovalStore, EntryStore, GoalStore, LOCAL_ACCOUNT, openSqliteStore, PushStore, type SessionStore, type SqlStore } from './store/index.js';

export const BITL_HOME = process.env.BITL_HOME?.trim() || join(homedir(), '.bitl');
export const PORT = Number(process.env.BITL_PORT ?? 7777);
// Local mode: reachable only from this PC. Other devices connect through the cloud server
const HOST = process.env.BITL_HOST ?? '127.0.0.1';
const SWEEP_INTERVAL_MS = 30_000;
const PRUNE_INTERVAL_MS = 60 * 60_000;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60_000;
/** Retention for the raw event log (signals only, kept for debugging). Session and turn summaries are kept */
const EVENT_RETENTION_DAYS = Number(process.env.BITL_EVENT_RETENTION_DAYS ?? 14);
export const env = (name: string) => process.env[name]?.trim() || undefined;

const here = dirname(fileURLToPath(import.meta.url));
// The npm package (@usebitl/cli) bundles the web build and points to it via BITL_WEB_DIST
export const WEB_DIST = env('BITL_WEB_DIST') ?? resolve(here, '../../web/dist');

/**
 * Processes events the adapter queued (queue.jsonl) while the server was down — local mode only (the queue file is on the same PC).
 * The adapter queues encrypted records, so they're accepted as is. Old-format (raw payload) lines are dropped.
 */
export async function drainQueue(store: SessionStore, home = BITL_HOME): Promise<number> {
  const queue = join(home, 'queue.jsonl');
  if (!existsSync(queue)) return 0;
  // Move it first so it doesn't mix with lines the adapter writes meanwhile
  const processing = `${queue}.${process.pid}.processing`;
  renameSync(queue, processing);
  let n = 0;
  const records = readFileSync(processing, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as { signal?: { at?: string } }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => (a.signal?.at ?? '').localeCompare(b.signal?.at ?? ''));
  for (const rec of records) if (await ingestRecord(store, LOCAL_ACCOUNT, rec)) n++;
  unlinkSync(processing);
  return n;
}

/** Shared services on top of the store: remote approval, goals, entries, web push (no notifications for accounts where canWrite is false) */
export function coreServices(store: SqlStore, access: AccessPolicy = allowAll) {
  const logError = errorLogger;
  // Web push: when a card turns "waiting for you" or error, notify subscribed devices (content stays ciphertext — the device decrypts it)
  const vapidPublic = env('BITL_VAPID_PUBLIC_KEY');
  const vapidPrivate = env('BITL_VAPID_PRIVATE_KEY');
  const pushStore = vapidPublic && vapidPrivate ? new PushStore(store.db) : undefined;
  // Remote approval: relay requests posted by the PC's hook until the phone allows or denies
  const approvals = new ApprovalStore(store.db);
  const goals = new GoalStore(store.db);
  const entries = new EntryStore(store.db);
  // When a card leaves "waiting for you" (answered in the terminal or on another device), close leftover approval requests
  const offApprovalCleanup = closeApprovalsOnResume(store, approvals, logError('approval request cleanup'));
  const notifier = pushStore
    ? startPushNotifier({
        store,
        push: pushStore,
        approvals,
        canNotify: (accountId) => access.canWrite(accountId),
        sender: webPushSender({ publicKey: vapidPublic!, privateKey: vapidPrivate!, subject: env('BITL_VAPID_SUBJECT') ?? 'mailto:support@usebitl.com' }),
        onError: logError('push notification'),
      })
    : undefined;
  return {
    /** Passed to createApp */
    app: { push: pushStore && { store: pushStore, publicKey: vapidPublic! }, approvals, goals, entries, access },
    approvals,
    pushing: Boolean(notifier),
    stop() {
      notifier?.stop();
      offApprovalCleanup();
    },
  };
}

export const errorLogger = (what: string) => (err: unknown) => console.error(`${what} failed:`, err instanceof Error ? err.message : err);

export interface RunOptions {
  store: SqlStore;
  services: ReturnType<typeof coreServices>;
  app: { fetch: (req: Request) => Response | Promise<Response> };
  /** Store location for the startup log */
  where: string;
  /** Extra lines for the startup log */
  info?: string[];
  /** Every 30 s (clean up expired items) */
  sweep?: () => void;
  /** Hourly (prune old data) */
  prune?: () => void;
}

/** Starts the server and runs periodic jobs (stale check, cleanup). Closes on SIGINT/SIGTERM */
export function runServer({ store, services, app, where, info = [], sweep, prune }: RunOptions) {
  const logError = errorLogger;
  const sweeper = setInterval(() => {
    store.sweepStale().catch(logError('stale check'));
    services.approvals.sweep().catch(logError('expired approval cleanup'));
    sweep?.();
  }, SWEEP_INTERVAL_MS);
  const pruneAll = () => {
    store.pruneEvents(new Date(Date.now() - EVENT_RETENTION_DAYS * 86_400_000)).catch(logError('event pruning'));
    prune?.();
  };
  void pruneAll();
  const pruner = setInterval(pruneAll, PRUNE_INTERVAL_MS);

  const server = serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (i) => {
    console.log(`bitl-server listening on http://${HOST}:${i.port}`);
    console.log(`  db: ${where}`);
    for (const line of info) console.log(`  ${line}`);
    // The local edition doesn't use web push, so only mention it when on
    if (services.pushing) console.log('  push: on (VAPID)');
    if (store.backupPath) {
      console.log(`  db: moved the old-format DB (plaintext content) aside and started fresh → ${store.backupPath}`);
      console.log('      Delete this file if the old history is not needed (it contains plaintext).');
    }
    if (!existsSync(WEB_DIST)) console.log('  web: no build (pnpm --filter @bitl/web build) — use the vite dev server during development');
  });

  const shutdown = async () => {
    clearInterval(sweeper);
    clearInterval(pruner);
    services.stop();
    server.close();
    await store.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/** Local mode: SQLite on this PC ($BITL_HOME/bitl.db), no login, 127.0.0.1 only */
/**
 * Newer @usebitl/cli for the local board's banner (/api/me .update). Checked at start, then every few hours
 * (the registry itself is asked at most once a day — see checkCliUpdate). Never delays the server start.
 */
function watchCliUpdate(): () => CliUpdate | undefined {
  let update: CliUpdate | undefined;
  const refresh = () =>
    checkCliUpdate().then(
      (u) => (update = u),
      () => {},
    );
  void refresh();
  setInterval(refresh, UPDATE_CHECK_INTERVAL_MS).unref();
  return () => update;
}

export async function startServer() {
  const file = join(BITL_HOME, 'bitl.db');
  const store = openSqliteStore(file);
  const drained = await drainQueue(store);
  const services = coreServices(store);
  const update = watchCliUpdate();
  const app = createApp({ store, webDist: WEB_DIST, ...services.app, extension: { me: () => ({ mode: 'local', update: update() }) } });
  runServer({ store, services, app, where: file, info: drained ? [`queue: processed ${drained} pending events`] : [] });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
