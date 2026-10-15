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
 * True in the npm package (@usebitl/cli): the local MCP server (claude-desktop) is left out.
 * The default login URL is also set at build time (define in packages/cli/npm/build.mjs)
 */
const NPM_BUILD = process.env.BITL_NPM_BUILD === '1';
const DEFAULT_URL = process.env.BITL_DEFAULT_URL;

/** One help line: commands are aligned in the left column, or followed by three spaces if too long. Korean characters take two columns in a terminal */
const row = (cmd: string, desc: string) => {
  const width = cmd.length + (cmd.match(/[가-힣]/g)?.length ?? 0);
  return `  ${width < 40 ? cmd + ' '.repeat(40 - width) : `${cmd}   `}${desc}`;
};

const usage = () =>
  [
    t('usage.title'),
    '',
    row('bitl start', t('usage.start')),
    row('bitl status', t('usage.status')),
    row(`bitl pair ${t('usage.pairArgs')}`, t('usage.pair')),
    '',
    DEFAULT_URL
      ? row(`bitl login ${t('usage.loginArgsDefault')}`, t('usage.loginDefault', { url: DEFAULT_URL }))
      : row(`bitl login ${t('usage.loginArgs')}`, t('usage.login')),
    row('bitl logout', t('usage.logout')),
    '',
    row('bitl install claude [--project D]', t('usage.installClaude')),
    row('bitl install codex', t('usage.installCodex')),
    row('bitl install antigravity', t('usage.installAgy')),
    ...(NPM_BUILD ? [] : [row('bitl install claude-desktop', t('usage.installDesktop'))]),
    `  bitl uninstall <claude|codex|antigravity${NPM_BUILD ? '' : '|claude-desktop'}> [--project D]`,
    '',
    row('bitl remote [on|off]', t('usage.remote')),
    row('', t('usage.remote2')),
    '',
    row('bitl --version', t('usage.version')),
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

/** Request to the target (the cloud account after bitl login, otherwise the local server) */
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
 * Link that hands the key to the browser. Browsers never send the part after # (fragment) to the server — the server never knows the key.
 * Interim local-mode approach: in the cloud server phase this becomes a device key pair + QR
 */
/**
 * Address the browser opens the board at. Browsers store the key per address, so it must match the address actually opened
 * (127.0.0.1 and localhost are different addresses). Order: --url → BITL_PUBLIC_URL (cloud mode) → this PC's local server
 */
const boardUrl = (override?: string) =>
  (override?.trim() || process.env.BITL_PUBLIC_URL?.trim() || readCloudConfig()?.url || serverUrl()).replace(/\/+$/, '');
/** The account key if connected to a cloud account, otherwise the local key */
const masterForPair = () => (readCloudConfig() ? readFileSync(cloudKeyPath(), 'utf8').trim() : loadOrCreateMasterKey());
const pairUrl = (base?: string) => `${boardUrl(base)}/#key=${masterForPair()}`;
/** Link for the local server started by bitl start — local address and local key even on a cloud-connected PC (never print the account key) */
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
  // Cloud Claude (remote MCP) cards are locked with the inbox key — fetch the private key sealed with the account key and open them
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

/** Turn remote approval on/off or show it (bitl remote, formerly bitl away) */
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
      // Codex only runs hooks the user has trusted (recorded by a hash of the definition — trust again if the path changes)
      extra = `${t('install.adapter', { path: ADAPTER_PATH })}\n  ${t('install.codexTrust')}`;
      break;
    case 'antigravity':
      file = antigravityHooksPath();
      result = updateSettingsFile(file, add ? (c) => addAntigravityHooks(c) : removeAntigravityHooks);
      extra = `${t('install.adapter', { path: ADAPTER_PATH })}\n  ${t('install.agyRestart')}`;
      break;
    case 'claude-desktop':
      if (NPM_BUILD) throw new Error(t('err.noDesktop'));
      file = claudeDesktopConfigPath();
      result = updateSettingsFile(file, add ? (c) => addMcpServer(c) : removeMcpServer);
      extra = `${t('install.mcp', { path: MCP_PATH })}\n  ${t('install.desktopRestart')}`;
      break;
    default:
      throw new Error(
        t('err.unknownTarget', { target: target ?? t('err.none'), list: `claude, codex, antigravity${NPM_BUILD ? '' : ', claude-desktop'}` }),
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
      // The local server stores data with node:sqlite (Node 22.5+); other commands work on older Node
      const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
      if (major < 22 || (major === 22 && minor < 5)) throw new Error(t('err.nodeSqlite', { version: process.version }));
      // Node prints "SQLite is an experimental feature" on first use — reads like an error on a first run. Hide only that one
      const emitWarning = process.emitWarning.bind(process);
      process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
        if (String(typeof warning === 'string' ? warning : warning.message).startsWith('SQLite is an experimental feature')) return;
        (emitWarning as (...a: unknown[]) => void)(warning, ...rest);
      }) as typeof process.emitWarning;
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
      // --no-browser: do not open a browser automatically (e.g. a PC reached over SSH — open the link on another device)
      return login(url, option(rest, '--name'), { openBrowser: !rest.includes('--no-browser') });
    }
    case 'logout':
      return logout();
    case '--version':
    case '-v':
    case 'version':
      // set at build time for the npm package (npm/build.mjs); running from the repo has no release version
      console.log(process.env.BITL_CLIENT_VERSION ?? 'dev');
      return;
    case 'remote':
    case 'away': // former name
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
    // New-version notice for commands a person typed (bitl start too: printed once the server is up; the board shows it as well).
    // Goes to stderr so it doesn't pollute JSON output etc.
    const notice = await updateNotice();
    if (notice) console.error(`\n${notice}`);
  });
