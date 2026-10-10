import { existsSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { type AccessPolicy, allowAll } from './access.js';
import { closeApprovalsOnResume } from './approvals-api.js';
import { createApp, ingestRecord } from './app.js';
import { startPushNotifier, webPushSender } from './push.js';
import { ApprovalStore, GoalStore, LOCAL_ACCOUNT, openSqliteStore, PushStore, type SessionStore, type SqlStore } from './store/index.js';

export const BITL_HOME = process.env.BITL_HOME?.trim() || join(homedir(), '.bitl');
export const PORT = Number(process.env.BITL_PORT ?? 7777);
// 로컬 모드: 이 PC 에서만 접속 가능. 다른 기기 접속은 클라우드 서버로
const HOST = process.env.BITL_HOST ?? '127.0.0.1';
const SWEEP_INTERVAL_MS = 30_000;
const PRUNE_INTERVAL_MS = 60 * 60_000;
/** 원본 이벤트(타임라인) 보관 기간. 세션·턴 요약은 계속 남는다 */
const EVENT_RETENTION_DAYS = Number(process.env.BITL_EVENT_RETENTION_DAYS ?? 14);
export const env = (name: string) => process.env[name]?.trim() || undefined;

const here = dirname(fileURLToPath(import.meta.url));
export const WEB_DIST = resolve(here, '../../web/dist');

/**
 * 서버가 꺼져 있을 때 어댑터가 쌓아둔 이벤트(queue.jsonl)를 처리한다 — 로컬 모드 전용 (큐 파일이 같은 PC 에 있다).
 * 어댑터는 암호화한 레코드를 쌓으므로 여기서도 그대로 받는다. 옛 형식(원본 페이로드) 줄은 버린다.
 */
export async function drainQueue(store: SessionStore, home = BITL_HOME): Promise<number> {
  const queue = join(home, 'queue.jsonl');
  if (!existsSync(queue)) return 0;
  // 처리 중에 어댑터가 새로 쓰는 줄과 섞이지 않도록 먼저 옮긴다
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

/** 저장소 위에 붙는 공통 부분: 원격 승인·목표·웹 푸시 (canWrite 가 false 인 계정에는 알림을 보내지 않는다) */
export function coreServices(store: SqlStore, access: AccessPolicy = allowAll) {
  const logError = errorLogger;
  // 웹 푸시: 카드가 "나를 기다림"·오류로 바뀌면 구독한 기기로 알림 (내용은 암호문 그대로 — 기기가 푼다)
  const vapidPublic = env('BITL_VAPID_PUBLIC_KEY');
  const vapidPrivate = env('BITL_VAPID_PRIVATE_KEY');
  const pushStore = vapidPublic && vapidPrivate ? new PushStore(store.db) : undefined;
  // 원격 승인: PC 의 hook 이 올린 요청을 폰이 허용·거부할 때까지 중계
  const approvals = new ApprovalStore(store.db);
  const goals = new GoalStore(store.db);
  // 카드가 "나를 기다림"을 벗어나면 (터미널·다른 기기에서 답함) 남은 승인 요청을 닫는다
  const offApprovalCleanup = closeApprovalsOnResume(store, approvals, logError('승인 요청 정리'));
  const notifier = pushStore
    ? startPushNotifier({
        store,
        push: pushStore,
        approvals,
        canNotify: (accountId) => access.canWrite(accountId),
        sender: webPushSender({ publicKey: vapidPublic!, privateKey: vapidPrivate!, subject: env('BITL_VAPID_SUBJECT') ?? 'mailto:support@usebitl.com' }),
        onError: logError('푸시 알림'),
      })
    : undefined;
  return {
    /** createApp 에 넘길 것 */
    app: { push: pushStore && { store: pushStore, publicKey: vapidPublic! }, approvals, goals, access },
    approvals,
    pushing: Boolean(notifier),
    stop() {
      notifier?.stop();
      offApprovalCleanup();
    },
  };
}

export const errorLogger = (what: string) => (err: unknown) => console.error(`${what} 실패:`, err instanceof Error ? err.message : err);

export interface RunOptions {
  store: SqlStore;
  services: ReturnType<typeof coreServices>;
  app: { fetch: (req: Request) => Response | Promise<Response> };
  /** 시작 로그의 저장소 위치 */
  where: string;
  /** 시작 로그에 더할 줄 */
  info?: string[];
  /** 30초마다 (만료된 것 정리) */
  sweep?: () => void;
  /** 한 시간마다 (오래된 데이터 정리) */
  prune?: () => void;
}

/** 서버를 띄우고 주기 작업(stale 검사·정리)을 돌린다. SIGINT·SIGTERM 에 닫는다 */
export function runServer({ store, services, app, where, info = [], sweep, prune }: RunOptions) {
  const logError = errorLogger;
  const sweeper = setInterval(() => {
    store.sweepStale().catch(logError('stale 검사'));
    services.approvals.sweep().catch(logError('만료된 승인 요청 정리'));
    sweep?.();
  }, SWEEP_INTERVAL_MS);
  const pruneAll = () => {
    store.pruneEvents(new Date(Date.now() - EVENT_RETENTION_DAYS * 86_400_000)).catch(logError('이벤트 정리'));
    prune?.();
  };
  void pruneAll();
  const pruner = setInterval(pruneAll, PRUNE_INTERVAL_MS);

  const server = serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (i) => {
    console.log(`bitl-server listening on http://${HOST}:${i.port}`);
    console.log(`  db: ${where}`);
    for (const line of info) console.log(`  ${line}`);
    // 로컬판은 웹 푸시를 쓰지 않으므로 켜졌을 때만 알린다
    if (services.pushing) console.log('  push: on (VAPID)');
    if (store.backupPath) {
      console.log(`  db: 옛 형식(내용 평문) DB 를 옮겨 두고 새로 시작합니다 → ${store.backupPath}`);
      console.log('      옛 기록이 필요 없으면 이 파일을 지우세요 (평문이 들어 있습니다).');
    }
    if (!existsSync(WEB_DIST)) console.log('  web: 빌드 없음 (pnpm --filter @bitl/web build) — 개발 중이면 vite dev 서버 사용');
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

/** 로컬 모드: 이 PC 의 SQLite ($BITL_HOME/bitl.db), 로그인 없음, 127.0.0.1 에서만 */
export async function startServer() {
  const file = join(BITL_HOME, 'bitl.db');
  const store = openSqliteStore(file);
  const drained = await drainQueue(store);
  const services = coreServices(store);
  const app = createApp({ store, webDist: WEB_DIST, ...services.app });
  runServer({ store, services, app, where: file, info: drained ? [`queue: 밀린 이벤트 ${drained}건 처리`] : [] });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
