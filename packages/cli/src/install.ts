import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { t } from './i18n.js';

/** 보드에 필요한 Claude Code hook 이벤트 */
export const CLAUDE_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'Stop',
  'StopFailure',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'CwdChanged',
] as const;

/** 우리가 넣은 hook 인지 구분하는 표식 (command 에 포함) */
const MARKERS = ['bitl-hook.mjs', 'bitl-approve.mjs'];

const here = dirname(fileURLToPath(import.meta.url));
/**
 * hook 이 실행할 어댑터 폴더. 저장소에서는 packages/adapters, npm 패키지(@usebitl/cli)에서는 실행할 때마다 복사해 두는
 * ~/.bitl/adapters (BITL_ADAPTER_DIR) — npm 전역 폴더는 Node 버전(nvm 등)에 따라 바뀌어 hook 이 끊길 수 있어서
 */
const ADAPTER_DIR = process.env.BITL_ADAPTER_DIR ?? resolve(here, '../../adapters');
export const ADAPTER_PATH = resolve(ADAPTER_DIR, 'bitl-hook.mjs').replaceAll('\\', '/');
export const APPROVE_PATH = resolve(ADAPTER_DIR, 'bitl-approve.mjs').replaceAll('\\', '/');
/**
 * 원격 승인 hook 의 시간 제한(초). hook 은 원격 승인이 켜졌을 때만 폰의 답을 기다린다 (기본 10분, bitl-approve.mjs).
 * 그보다 길게 둬서 hook 이 스스로 그만 기다리고 정리하게 한다 (Claude Code 가 먼저 끊지 않게)
 */
export const APPROVE_TIMEOUT_SEC = 660;

type HookEntry = { type: string; command?: string; [k: string]: unknown };
type HookGroup = { matcher?: string; hooks: HookEntry[] };
type Settings = { hooks?: Record<string, HookGroup[]>; [k: string]: unknown };

export const hookCommand = (source = 'claude-code', adapter = ADAPTER_PATH) => `node "${adapter}" --source ${source}`;

const isOurs = (h: HookEntry) => typeof h.command === 'string' && MARKERS.some((m) => h.command!.includes(m));
export const approveCommand = (adapter = APPROVE_PATH) => `node "${adapter}" --source claude-code`;

/** settings 에서 우리 hook 을 모두 뺀다. 다른 hook 은 건드리지 않는다. */
export function removeHooks(settings: Settings): Settings {
  if (!settings.hooks) return settings;
  const hooks: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const kept = groups
      .map((g) => ({ ...g, hooks: g.hooks.filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length) hooks[event] = kept;
  }
  const { hooks: _, ...rest } = settings;
  return Object.keys(hooks).length ? { ...rest, hooks } : rest;
}

/** 우리 hook 을 (기존 것은 교체하며) 추가한다. 여러 번 실행해도 결과가 같다. */
export function addHooks(settings: Settings, command = hookCommand(), approve: string | null = approveCommand()): Settings {
  const base = removeHooks(settings);
  const hooks = { ...(base.hooks ?? {}) };
  for (const event of CLAUDE_EVENTS) {
    hooks[event] = [...(hooks[event] ?? []), { matcher: '*', hooks: [{ type: 'command', command, async: true, timeout: 10 }] }];
  }
  // 원격 승인: 결과(allow/deny)를 돌려줘야 하므로 동기 hook. 원격 승인이 꺼져 있으면 바로 끝난다
  if (approve) {
    hooks.PermissionRequest = [
      ...(hooks.PermissionRequest ?? []),
      { matcher: '*', hooks: [{ type: 'command', command: approve, timeout: APPROVE_TIMEOUT_SEC }] },
    ];
  }
  return { ...base, hooks };
}

export type UpdateResult = { changed: boolean; backup?: string };

/** 설정 파일을 백업한 뒤 변경을 쓴다. 바뀐 게 없으면 쓰지 않는다. */
export function updateTextFile(file: string, change: (text: string) => string): UpdateResult {
  const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const after = change(before);
  if (after === before) return { changed: false };
  let backup: string | undefined;
  if (existsSync(file)) {
    backup = `${file}.bitl-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(file, backup);
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, after, 'utf8');
  return { changed: true, backup };
}

/** JSON 설정 파일용. 의미가 같으면(키 순서·공백 차이만) 쓰지 않는다. */
export function updateSettingsFile(file: string, change: (s: Settings) => Settings): UpdateResult {
  return updateTextFile(file, (text) => {
    const before = (text.trim() ? JSON.parse(text) : {}) as Settings;
    const after = change(before);
    return JSON.stringify(before) === JSON.stringify(after) ? text : JSON.stringify(after, null, 2) + '\n';
  });
}

// ─── Codex (~/.codex/config.toml) ──────────────────────────────────────────────
// TOML 파서 없이 우리 hook 표만 추가/제거한다. 사용자의 다른 설정은 건드리지 않는다.
// Codex 는 /hooks 에서 신뢰를 저장할 때 파일을 통째로 다시 써서 [hooks.state] 를 표식 블록 안에 넣기도 한다
// → 제거는 표식 범위가 아니라 "command 에 우리 어댑터가 든 [[hooks.X.hooks]] 표와 그 빈 [[hooks.X]] 머리"만 지운다.

export const CODEX_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'Interrupt',
] as const;

/** Codex 가 timeout 을 최대 3초로 깎는 이벤트 (넘기면 실행마다 경고) */
const CODEX_SHORT_EVENTS: ReadonlySet<string> = new Set(['SessionEnd', 'Interrupt']);

const CODEX_BEGIN = '# >>> bitl (bitl install codex) >>>';
const CODEX_END = '# <<< bitl <<<';

export const codexConfigPath = () => join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml');

export function removeCodexBlock(toml: string): string {
  // 표 머리([...]) 마다 구역을 나눈다. 첫 구역은 머리 없는 앞부분
  const sections: string[][] = [[]];
  for (const line of toml.split('\n')) {
    const t = line.trim();
    if (t === CODEX_BEGIN || t === CODEX_END) continue;
    if (t.startsWith('[')) sections.push([]);
    sections[sections.length - 1]!.push(line);
  }
  const header = (sec: string[]) => sec[0]?.trim() ?? '';
  const drop = new Set<number>();
  sections.forEach((sec, i) => {
    const m = /^\[\[hooks\.(\w+)\.hooks\]\]$/.exec(header(sec));
    if (!m || !sec.some((l) => MARKERS.some((mk) => l.includes(mk)))) return;
    drop.add(i);
    const prev = sections[i - 1];
    if (prev && header(prev) === `[[hooks.${m[1]}]]` && prev.slice(1).every((l) => !l.trim())) drop.add(i - 1);
  });
  const kept = sections.filter((_, i) => !drop.has(i)).flat().join('\n');
  const tidy = kept.replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '\n');
  return tidy.trim() ? tidy : '';
}

export function addCodexBlock(toml: string, command = hookCommand('codex')): string {
  // TOML literal string('...') 은 안의 큰따옴표를 그대로 둔다
  const lines = [CODEX_BEGIN];
  for (const event of CODEX_EVENTS) {
    lines.push(`[[hooks.${event}]]`, `[[hooks.${event}.hooks]]`, 'type = "command"', `command = '${command}'`, 'async = true', `timeout = ${CODEX_SHORT_EVENTS.has(event) ? 3 : 10}`, '');
  }
  // 원격 승인(동기 PermissionRequest hook)은 넣지 않는다: Codex 는 hook 이 답할 때까지 터미널 승인 창을 띄우지 않아
  // 원격 승인이 켜져 있으면 PC 앞에서 승인할 수 없게 된다 — bitl 은 에이전트를 방해하지 않는다 (2026-10-03 확인)
  lines[lines.length - 1] = CODEX_END;
  const base = removeCodexBlock(toml);
  return (base ? base.replace(/\n*$/, '\n\n') : '') + lines.join('\n') + '\n';
}

// ─── Antigravity (~/.gemini/config/hooks.json) ─────────────────────────────────
// 이름 붙은 hook 묶음({ "<이름>": { "<이벤트>": [...] } }) 중 "bitl" 만 넣고 뺀다. CLI·IDE 가 같은 파일을 읽는다.
// 주의 (agy 1.2, Windows 에서 확인):
//   - command 를 셸 없이 실행해 따옴표가 그대로 인자로 간다 → 경로를 따옴표로 감쌀 수 없다 (공백 있는 경로는 거부)
//   - hook 이 실패하면 도구 실행이 막힌다 → 어댑터는 항상 exit 0
//   - 페이로드에 이벤트 이름이 없다 → --event 로 넘긴다

export const ANTIGRAVITY_EVENTS = ['PreInvocation', 'PreToolUse', 'PostToolUse', 'Stop'] as const;
const ANTIGRAVITY_TOOL_EVENTS: ReadonlySet<string> = new Set(['PreToolUse', 'PostToolUse']);
const ANTIGRAVITY_HOOK_NAME = 'bitl';

export const antigravityHooksPath = () => join(homedir(), '.gemini', 'config', 'hooks.json');

type NamedHooks = Record<string, unknown>;

export function addAntigravityHooks(config: NamedHooks, adapter = ADAPTER_PATH): NamedHooks {
  if (/\s/.test(adapter)) throw new Error(t('err.agySpace', { path: adapter }));
  const group: Record<string, unknown> = { enabled: true };
  for (const event of ANTIGRAVITY_EVENTS) {
    const handler = { type: 'command', command: `node ${adapter} --source antigravity --event ${event}`, timeout: 10 };
    group[event] = ANTIGRAVITY_TOOL_EVENTS.has(event) ? [{ matcher: '*', hooks: [handler] }] : [handler];
  }
  return { ...removeAntigravityHooks(config), [ANTIGRAVITY_HOOK_NAME]: group };
}

export function removeAntigravityHooks(config: NamedHooks): NamedHooks {
  const { [ANTIGRAVITY_HOOK_NAME]: _ours, ...rest } = config;
  return rest;
}

// ─── Claude Desktop (claude_desktop_config.json) ───────────────────────────────

export const MCP_PATH = resolve(ADAPTER_DIR, 'bitl-mcp.mjs').replaceAll('\\', '/');

/**
 * Windows 스토어(MSIX) 설치본은 앱이 보는 %APPDATA% 가 패키지 폴더로 가상화된다:
 *   %LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude
 * 밖에서 %APPDATA%\Claude 에 쓰면 앱이 읽지 않으므로, 패키지 폴더가 있으면 그쪽을 쓴다.
 */
export function msixClaudeDir(localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')): string | undefined {
  const packages = join(localAppData, 'Packages');
  try {
    for (const pkg of readdirSync(packages).filter((d) => /^Claude_/.test(d))) {
      const dir = join(packages, pkg, 'LocalCache', 'Roaming', 'Claude');
      if (existsSync(dir)) return dir;
    }
  } catch {
    // Packages 폴더 없음
  }
  return undefined;
}

export function claudeDesktopConfigPath(): string {
  if (process.platform === 'win32') {
    const dir = msixClaudeDir() ?? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Claude');
    return join(dir, 'claude_desktop_config.json');
  }
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

type McpConfig = { mcpServers?: Record<string, unknown>; [k: string]: unknown };

export function addMcpServer(config: McpConfig, mcpPath = MCP_PATH, source = 'claude-desktop'): McpConfig {
  return { ...config, mcpServers: { ...(config.mcpServers ?? {}), bitl: { command: 'node', args: [mcpPath, '--source', source] } } };
}

export function removeMcpServer(config: McpConfig): McpConfig {
  if (!config.mcpServers || !('bitl' in config.mcpServers)) return config;
  const { bitl: _, ...rest } = config.mcpServers;
  return { ...config, mcpServers: rest };
}
