import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { t } from './i18n.js';

/** Claude Code hook events the board needs */
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

/** Marker identifying hooks we added (contained in command) */
const MARKERS = ['bitl-hook.mjs', 'bitl-approve.mjs'];

const here = dirname(fileURLToPath(import.meta.url));
/**
 * Adapter folder the hooks run. In the repo it is packages/adapters; in the npm package (@usebitl/cli) it is
 * ~/.bitl/adapters (BITL_ADAPTER_DIR), copied on every run — the global npm folder changes with the Node version (nvm etc.) and hooks could break
 */
const ADAPTER_DIR = process.env.BITL_ADAPTER_DIR ?? resolve(here, '../../adapters');
export const ADAPTER_PATH = resolve(ADAPTER_DIR, 'bitl-hook.mjs').replaceAll('\\', '/');
export const APPROVE_PATH = resolve(ADAPTER_DIR, 'bitl-approve.mjs').replaceAll('\\', '/');
/**
 * Timeout (seconds) of the remote approval hook. The hook waits for the phone's answer only when remote approval is on (default 10 min, bitl-approve.mjs).
 * Set longer than that so the hook gives up and cleans up on its own (before Claude Code cuts it off)
 */
export const APPROVE_TIMEOUT_SEC = 660;

type HookEntry = { type: string; command?: string; [k: string]: unknown };
type HookGroup = { matcher?: string; hooks: HookEntry[] };
type Settings = { hooks?: Record<string, HookGroup[]>; [k: string]: unknown };

export const hookCommand = (source = 'claude-code', adapter = ADAPTER_PATH) => `node "${adapter}" --source ${source}`;

const isOurs = (h: HookEntry) => typeof h.command === 'string' && MARKERS.some((m) => h.command!.includes(m));
export const approveCommand = (adapter = APPROVE_PATH) => `node "${adapter}" --source claude-code`;

/** Removes all our hooks from settings. Other hooks are left alone. */
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

/** Adds our hooks (replacing existing ones). Idempotent. */
export function addHooks(settings: Settings, command = hookCommand(), approve: string | null = approveCommand()): Settings {
  const base = removeHooks(settings);
  const hooks = { ...(base.hooks ?? {}) };
  for (const event of CLAUDE_EVENTS) {
    hooks[event] = [...(hooks[event] ?? []), { matcher: '*', hooks: [{ type: 'command', command, async: true, timeout: 10 }] }];
  }
  // Remote approval: a sync hook since it must return a result (allow/deny). Exits immediately when remote approval is off
  if (approve) {
    hooks.PermissionRequest = [
      ...(hooks.PermissionRequest ?? []),
      { matcher: '*', hooks: [{ type: 'command', command: approve, timeout: APPROVE_TIMEOUT_SEC }] },
    ];
  }
  return { ...base, hooks };
}

export type UpdateResult = { changed: boolean; backup?: string };

/** Backs up the settings file, then writes the change. Writes nothing if nothing changed. */
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

/** For JSON settings files. Skips the write if semantically equal (only key order/whitespace differ). */
export function updateSettingsFile(file: string, change: (s: Settings) => Settings): UpdateResult {
  return updateTextFile(file, (text) => {
    const before = (text.trim() ? JSON.parse(text) : {}) as Settings;
    const after = change(before);
    return JSON.stringify(before) === JSON.stringify(after) ? text : JSON.stringify(after, null, 2) + '\n';
  });
}

// ─── Codex (~/.codex/config.toml) ──────────────────────────────────────────────
// Adds/removes only our hook tables without a TOML parser. The user's other settings are left alone.
// When saving trust from /hooks, Codex rewrites the whole file and may put [hooks.state] inside our marker block
// → removal deletes not the marker range but only "[[hooks.X.hooks]] tables whose command has our adapter, and their empty [[hooks.X]] headers".

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

/** Events for which Codex caps timeout at 3 seconds (exceeding it warns on every run) */
const CODEX_SHORT_EVENTS: ReadonlySet<string> = new Set(['SessionEnd', 'Interrupt']);

const CODEX_BEGIN = '# >>> bitl (bitl install codex) >>>';
const CODEX_END = '# <<< bitl <<<';

export const codexConfigPath = () => join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml');

export function removeCodexBlock(toml: string): string {
  // Split into sections at each table header ([...]). The first section is the header-less preamble
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
  // A TOML literal string ('...') keeps inner double quotes as is
  const lines = [CODEX_BEGIN];
  for (const event of CODEX_EVENTS) {
    lines.push(`[[hooks.${event}]]`, `[[hooks.${event}.hooks]]`, 'type = "command"', `command = '${command}'`, 'async = true', `timeout = ${CODEX_SHORT_EVENTS.has(event) ? 3 : 10}`, '');
  }
  // No remote approval (sync PermissionRequest hook): Codex does not show its terminal approval prompt until the hook answers,
  // so with remote approval on you could not approve at the PC — bitl never gets in the agent's way (verified 2026-10-03)
  lines[lines.length - 1] = CODEX_END;
  const base = removeCodexBlock(toml);
  return (base ? base.replace(/\n*$/, '\n\n') : '') + lines.join('\n') + '\n';
}

// ─── Antigravity (~/.gemini/config/hooks.json) ─────────────────────────────────
// Of the named hook groups ({ "<name>": { "<event>": [...] } }), only "bitl" is added/removed. The CLI and IDE read the same file.
// Caveats (verified with agy 1.2 on Windows):
//   - command runs without a shell, so quotes are passed literally as arguments → paths cannot be quoted (paths with spaces are rejected)
//   - a failing hook blocks the tool call → adapters always exit 0
//   - the payload has no event name → pass it via --event

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
 * For Windows Store (MSIX) installs, the %APPDATA% the app sees is virtualized into the package folder:
 *   %LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude
 * The app ignores writes to %APPDATA%\Claude from outside, so use the package folder when it exists.
 */
export function msixClaudeDir(localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')): string | undefined {
  const packages = join(localAppData, 'Packages');
  try {
    for (const pkg of readdirSync(packages).filter((d) => /^Claude_/.test(d))) {
      const dir = join(packages, pkg, 'LocalCache', 'Roaming', 'Claude');
      if (existsSync(dir)) return dir;
    }
  } catch {
    // no Packages folder
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
