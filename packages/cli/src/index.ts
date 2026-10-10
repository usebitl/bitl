import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { displayTitle, openSession, type StoredSession, unwrapInboxKey } from '@bitl/shared';
import { bitlHome, cloudKeyPath, keyPath, loadOrCreateMasterKey, readCloudConfig, resolveTarget } from '@bitl/shared/node';
import { readFileSync } from 'node:fs';
import {
  ADAPTER_PATH,
  addAntigravityHooks,
  addCodexBlock,
  addHooks,
  addMcpServer,
  antigravityHooksPath,
  claudeDesktopConfigPath,
  codexConfigPath,
  MCP_PATH,
  removeAntigravityHooks,
  removeCodexBlock,
  removeHooks,
  removeMcpServer,
  type UpdateResult,
  updateSettingsFile,
  updateTextFile,
} from './install.js';
import { t } from './i18n.js';
import { login, logout } from './login.js';
import { updateNotice } from './update.js';

/**
 * npm 패키지(@usebitl/cli)로 빌드하면 true — 클라우드 전용: 로컬 서버(bitl start)와 로컬 MCP(claude-desktop)는 빠진다.
 * 기본 연결 주소도 빌드할 때 정한다 (packages/cli/npm/build.mjs 의 define)
 */
const CLOUD_ONLY = process.env.BITL_CLOUD_ONLY === '1';
const DEFAULT_URL = process.env.BITL_DEFAULT_URL;

/** 도움말 한 줄: 명령은 왼쪽 칸에 맞추고, 길면 세 칸 띄운다. 한글은 터미널에서 두 칸을 차지한다 */
const row = (cmd: string, desc: string) => {
  const width = cmd.length + (cmd.match(/[가-힣]/g)?.length ?? 0);
  return `  ${width < 40 ? cmd + ' '.repeat(40 - width) : `${cmd}   `}${desc}`;
};

const usage = () =>
  [
    t('usage.title'),
    '',
    ...(CLOUD_ONLY ? [] : [row('bitl start', t('usage.start'))]),
    row('bitl status', t('usage.status')),
    row(`bitl pair ${t('usage.pairArgs')}`, t('usage.pair')),
    '',
    DEFAULT_URL
      ? row(`bitl login ${t('usage.loginArgsDefault')}`, t('usage.loginDefault', { url: DEFAULT_URL }))
      : row(`bitl login ${t('usage.loginArgs')}`, t('usage.login')),
    row('bitl logout', CLOUD_ONLY ? t('usage.logoutCloud') : t('usage.logout')),
    '',
    row('bitl install claude [--project D]', t('usage.installClaude')),
    row('bitl install codex', t('usage.installCodex')),
    row('bitl install antigravity', t('usage.installAgy')),
    ...(CLOUD_ONLY ? [] : [row('bitl install claude-desktop', t('usage.installDesktop'))]),
    `  bitl uninstall <claude|codex|antigravity${CLOUD_ONLY ? '' : '|claude-desktop'}> [--project D]`,
    '',
    row('bitl remote [on|off]', t('usage.remote')),
    row('', t('usage.remote2')),
  ].join('\n');

const serverUrl = () => process.env.BITL_URL ?? `http://127.0.0.1:${process.env.BITL_PORT ?? 7777}`;

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v) throw new Error(t('err.optionValue', { name }));
  args.splice(i, 2);
  return v;
}

/** 보낼 곳 (bitl login 했으면 클라우드 계정, 아니면 로컬 서버) 에 요청 */
async function request(path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  const target = resolveTarget();
  const res = await fetch(`${target.url}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json', ...target.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  }).catch(() => {
    throw new Error(
      target.kind === 'cloud' ? t('err.cloudUnreachable', { url: target.url }) : t('err.localUnreachable', { url: target.url }),
    );
  });
  if (res.status === 401) throw new Error(t('err.revoked'));
  return res;
}

/**
 * 브라우저에 키를 넘기는 링크. # 뒤(fragment)는 브라우저가 서버로 보내지 않는다 — 서버는 키를 모른다.
 * 로컬 모드 임시 방식: 클라우드 서버 단계에서는 기기 키쌍 + QR 로 바뀐다
 */
/**
 * 브라우저가 보드를 여는 주소. 브라우저는 키를 주소마다 따로 저장하므로 실제로 여는 주소와 같아야 한다
 * (127.0.0.1 과 localhost 도 다른 주소). 순서: --url → BITL_PUBLIC_URL(클라우드 모드) → 이 PC 의 로컬 서버
 */
const boardUrl = (override?: string) =>
  (override?.trim() || process.env.BITL_PUBLIC_URL?.trim() || readCloudConfig()?.url || serverUrl()).replace(/\/+$/, '');
/** 클라우드 계정에 연결했으면 그 계정 키, 아니면 로컬 키 */
const masterForPair = () => (readCloudConfig() ? readFileSync(cloudKeyPath(), 'utf8').trim() : loadOrCreateMasterKey());
const pairUrl = (base?: string) => `${boardUrl(base)}/#key=${masterForPair()}`;
/** bitl start 가 띄운 로컬 서버용 링크 — 클라우드에 연결한 PC 라도 로컬 주소·로컬 키 (계정 키를 화면에 찍지 않는다) */
const localPairUrl = () => `${serverUrl().replace(/\/+$/, '')}/#key=${loadOrCreateMasterKey()}`;

function pair(args: string[]) {
  const base = option(args, '--url');
  console.log(t('pair.intro'));
  console.log(`  ${pairUrl(base)}`);
  if (!base) console.log(t('pair.otherUrl'));
  if (readCloudConfig()) console.log(t('pair.cloud'));
  console.log(t('pair.keyFile', { path: readCloudConfig() ? cloudKeyPath() : keyPath(bitlHome()) }));
}

async function status() {
  const target = resolveTarget();
  let stored: StoredSession[];
  try {
    stored = (await (await request('/api/sessions')).json()) as StoredSession[];
  } catch (err) {
    console.log((err as Error).message);
    process.exitCode = 1;
    return;
  }
  if (target.kind === 'cloud') console.log(t('status.cloud', { url: target.url }));
  if (stored.length === 0) return console.log(t('status.none'));
  let keys = await target.keys();
  // 클라우드 Claude(원격 MCP) 카드는 받은편지함 키로 잠겨 있다 — 계정 키로 봉인된 개인키를 받아 연다
  if (target.kind === 'cloud') {
    const res = await request('/api/inbox-key').catch(() => null);
    const k = res?.ok ? ((await res.json()) as { wrappedPrivateKey?: string }) : null;
    if (k?.wrappedPrivateKey) keys = { ...keys, inbox: await unwrapInboxKey(keys, k.wrappedPrivateKey).catch(() => undefined) };
  }
  const sessions = await Promise.all(stored.map((s) => openSession(keys, s)));
  const icon: Record<string, string> = { waiting_for_you: '🔴', error: '🔴', running: '🟢', needs_review: '🟡', stale: '⚠️', idle: '⚪' };
  for (const s of sessions) {
    const where = [s.project, s.gitBranch].filter(Boolean).join('@') || s.source;
    console.log(`${icon[s.status] ?? '·'} ${s.status.padEnd(15)} ${where.padEnd(28)} ${displayTitle(s)}`);
    if (s.currentActivity) console.log(`  └ ${s.currentActivity}`);
  }
}

/** 원격 승인 켜기·끄기·보기 (bitl remote, 예전 이름 bitl away) */
async function away(arg: string | undefined) {
  if (arg !== undefined && arg !== 'on' && arg !== 'off') throw new Error(t('err.remoteUsage'));
  const res =
    arg === undefined ? await request('/api/approvals/mode') : await request('/api/approvals/mode', { method: 'PUT', body: { away: arg === 'on' } });
  if (res.status === 404) throw new Error(t('err.remoteUnsupported'));
  const { away: on } = (await res.json()) as { away: boolean };
  console.log(on ? t('remote.on') : t('remote.off'));
  if (on) console.log(t('remote.needHook'));
}

function install(cmd: 'install' | 'uninstall', target: string | undefined, args: string[]) {
  const add = cmd === 'install';
  let file: string;
  let result: UpdateResult;
  let extra: string | undefined;

  switch (target) {
    case 'claude': {
      const project = option(args, '--project');
      file = project ? join(resolve(project), '.claude', 'settings.json') : join(homedir(), '.claude', 'settings.json');
      result = updateSettingsFile(file, add ? (s) => addHooks(s) : removeHooks);
      extra = t('install.adapter', { path: ADAPTER_PATH });
      break;
    }
    case 'codex':
      file = codexConfigPath();
      result = updateTextFile(file, add ? (t) => addCodexBlock(t) : removeCodexBlock);
      // Codex 는 사용자가 신뢰한 hook 만 실행한다 (정의의 해시로 기록 — 경로가 바뀌어도 다시 신뢰)
      extra = `${t('install.adapter', { path: ADAPTER_PATH })}\n  ${t('install.codexTrust')}`;
      break;
    case 'antigravity':
      file = antigravityHooksPath();
      result = updateSettingsFile(file, add ? (c) => addAntigravityHooks(c) : removeAntigravityHooks);
      extra = `${t('install.adapter', { path: ADAPTER_PATH })}\n  ${t('install.agyRestart')}`;
      break;
    case 'claude-desktop':
      if (CLOUD_ONLY) throw new Error(t('err.noDesktop'));
      file = claudeDesktopConfigPath();
      result = updateSettingsFile(file, add ? (c) => addMcpServer(c) : removeMcpServer);
      extra = `${t('install.mcp', { path: MCP_PATH })}\n  ${t('install.desktopRestart')}`;
      break;
    default:
      throw new Error(
        t('err.unknownTarget', { target: target ?? t('err.none'), list: `claude, codex, antigravity${CLOUD_ONLY ? '' : ', claude-desktop'}` }),
      );
  }

  if (!result.changed) return console.log(t('install.unchanged', { file }));
  console.log(t(add ? 'install.added' : 'install.removed', { file }));
  if (result.backup) console.log(t('install.backup', { path: result.backup }));
  if (add && extra) console.log(`  ${extra}`);
}

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'start': {
      if (CLOUD_ONLY) throw new Error(t('err.noStart'));
      const { startServer } = await import('@bitl/server');
      await startServer();
      console.log(t('start.pair', { url: localPairUrl() }));
      return;
    }
    case 'install':
    case 'uninstall':
      return install(cmd, rest[0], rest.slice(1));
    case 'status':
      return status();
    case 'pair':
      return pair(rest);
    case 'login': {
      const url = option(rest, '--url') ?? process.env.BITL_PUBLIC_URL?.trim() ?? DEFAULT_URL;
      if (!url) throw new Error(t('err.loginUrl'));
      // --no-browser: 브라우저를 자동으로 열지 않는다 (SSH 로 접속한 PC 등 — 링크를 다른 기기에서 연다)
      return login(url, option(rest, '--name'), { openBrowser: !rest.includes('--no-browser') });
    }
    case 'logout':
      return logout();
    case 'remote':
    case 'away': // 예전 이름
      return away(rest[0]);
    default:
      console.log(usage());
  }
}

main(process.argv.slice(2))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .then(async () => {
    // 새 버전 안내는 사람이 직접 친 명령에서만 (bitl start 는 계속 도는 서버라 제외). 출력이 JSON 등으로 쓰이지 않게 stderr 로
    if (process.argv[2] === 'start') return;
    const notice = await updateNotice();
    if (notice) console.error(`\n${notice}`);
  });
