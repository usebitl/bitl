import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addAntigravityHooks,
  addCodexBlock,
  ANTIGRAVITY_EVENTS,
  addHooks,
  addMcpServer,
  APPROVE_TIMEOUT_SEC,
  approveCommand,
  CLAUDE_EVENTS,
  CODEX_EVENTS,
  hookCommand,
  removeAntigravityHooks,
  removeCodexBlock,
  removeHooks,
  removeMcpServer,
  updateSettingsFile,
} from '../src/install.js';

const cmd = hookCommand('claude-code', 'C:/bitl/packages/adapters/bitl-hook.mjs');
const other = { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-guard.sh' }] };

describe('addHooks / removeHooks', () => {
  it('adds while preserving existing settings and other hooks', () => {
    const out = addHooks({ theme: 'auto', hooks: { PreToolUse: [other] } }, cmd);
    expect(out.theme).toBe('auto');
    expect(Object.keys(out.hooks!)).toEqual(expect.arrayContaining([...CLAUDE_EVENTS]));
    expect(out.hooks!.PreToolUse).toEqual([other, { matcher: '*', hooks: [{ type: 'command', command: cmd, async: true, timeout: 10 }] }]);
  });

  it('does not duplicate when run repeatedly', () => {
    const once = addHooks({}, cmd);
    expect(addHooks(once, cmd)).toEqual(once);
  });

  it('removing takes out only our hooks and restores the original', () => {
    const original = { theme: 'auto', hooks: { PreToolUse: [other] } };
    expect(removeHooks(addHooks(original, cmd))).toEqual(original);
    expect(removeHooks(addHooks({ theme: 'auto' }, cmd))).toEqual({ theme: 'auto' });
  });

  it('remote approval hook only on PermissionRequest, sync (not async) with a long timeout', () => {
    const approve = approveCommand('C:/bitl/packages/adapters/bitl-approve.mjs');
    const out = addHooks({}, cmd, approve);
    expect(out.hooks!.PermissionRequest).toEqual([
      { matcher: '*', hooks: [{ type: 'command', command: cmd, async: true, timeout: 10 }] },
      { matcher: '*', hooks: [{ type: 'command', command: approve, timeout: APPROVE_TIMEOUT_SEC }] },
    ]);
    expect(JSON.stringify(out.hooks!.PreToolUse)).not.toContain('bitl-approve');
    expect(addHooks(out, cmd, approve)).toEqual(out);
    expect(removeHooks(out)).toEqual({});
  });
});

describe('updateSettingsFile', () => {
  it('leaves a backup and writes nothing if unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bitl-cli-'));
    const file = join(dir, 'settings.json');
    writeFileSync(file, JSON.stringify({ theme: 'auto' }));

    const first = updateSettingsFile(file, (s) => addHooks(s, cmd));
    expect(first.changed).toBe(true);
    expect(JSON.parse(readFileSync(first.backup!, 'utf8'))).toEqual({ theme: 'auto' });
    expect(JSON.parse(readFileSync(file, 'utf8')).hooks.Stop).toHaveLength(1);

    expect(updateSettingsFile(file, (s) => addHooks(s, cmd)).changed).toBe(false);
    expect(readdirSync(dir).filter((f) => f.includes('bitl-backup'))).toHaveLength(1);
  });

  it('creates the file if missing', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'bitl-cli-')), '.claude', 'settings.json');
    expect(updateSettingsFile(file, (s) => addHooks(s, cmd))).toEqual({ changed: true, backup: undefined });
  });
});

describe('Codex config.toml block', () => {
  const codexCmd = hookCommand('codex', 'C:/bitl/packages/adapters/bitl-hook.mjs');
  const userToml = 'model = "gpt-5"\n\n[tui]\nnotifications = true\n';

  it('appends a marker block after user settings, and removing restores the original text', () => {
    const added = addCodexBlock(userToml, codexCmd);
    expect(added.startsWith(userToml)).toBe(true);
    for (const e of CODEX_EVENTS) expect(added).toContain(`[[hooks.${e}.hooks]]`);
    expect(added).toContain(`command = 'node "C:/bitl/packages/adapters/bitl-hook.mjs" --source codex'`);
    expect(removeCodexBlock(added)).toBe(userToml);
  });

  it('only one block after repeated installs', () => {
    const twice = addCodexBlock(addCodexBlock(userToml, codexCmd), codexCmd);
    expect(twice.split('# >>> bitl').length - 1).toBe(1);
    expect(twice).toBe(addCodexBlock(userToml, codexCmd));
  });

  it('installs/removes on an empty file', () => {
    expect(removeCodexBlock(addCodexBlock('', codexCmd))).toBe('');
  });

  it('does not add the remote approval hook (Codex withholds its terminal approval prompt until the hook answers)', () => {
    expect(addCodexBlock(userToml, codexCmd)).not.toContain('bitl-approve.mjs');
  });

  it('keeps [hooks.state] and user hooks even when Codex rewrites the file and puts them inside the marker block', () => {
    const own = `[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = 'my-notify.exe'\n`;
    const state = `[hooks.state]\n[hooks.state.'C:\\\\Users\\\\me\\\\.codex\\\\config.toml:stop:0:0']\ntrusted_hash = "sha256:abc"\n`;
    // As rewritten by Codex: trust records are placed before the end marker
    const rewritten = addCodexBlock(userToml + '\n' + own, codexCmd).replace('# <<< bitl <<<', state + '# <<< bitl <<<');
    const removed = removeCodexBlock(rewritten);
    expect(removed).not.toContain('bitl-hook.mjs');
    expect(removed).not.toContain('# >>> bitl');
    expect(removed).toContain(own);
    expect(removed).toContain(state);
    expect(removed.startsWith(userToml)).toBe(true);
    // Reinstalling keeps trust records and user hooks, with a single copy of our tables
    const again = addCodexBlock(rewritten, codexCmd);
    expect(again.split('bitl-hook.mjs').length - 1).toBe(CODEX_EVENTS.length);
    expect(again).toContain(state);
    expect(again).toContain(own);
  });

  it('SessionEnd/Interrupt get the Codex cap of 3s, the rest 10s', () => {
    const timeoutOf = (e: string) => addCodexBlock('', codexCmd).split(`[[hooks.${e}.hooks]]`)[1]?.match(/timeout = (\d+)/)?.[1];
    expect(timeoutOf('SessionEnd')).toBe('3');
    expect(timeoutOf('Interrupt')).toBe('3');
    expect(timeoutOf('Stop')).toBe('10');
  });
});

describe('Antigravity hooks.json', () => {
  const adapter = 'C:/bitl/packages/adapters/bitl-hook.mjs';
  const user = { 'my-hook': { enabled: true, Stop: [{ type: 'command', command: './x.sh' }] } };

  it('adds/removes only the "bitl" group, preserving other hook groups', () => {
    const added = addAntigravityHooks(user, adapter);
    expect(added['my-hook']).toEqual(user['my-hook']);
    const ours = added.bitl as Record<string, unknown>;
    for (const e of ANTIGRAVITY_EVENTS) expect(ours[e]).toBeDefined();
    expect(removeAntigravityHooks(added)).toEqual(user);
    expect(addAntigravityHooks(added, adapter)).toEqual(added);
  });

  it('unquoted path, event name via --event, matcher only on tool events', () => {
    const ours = addAntigravityHooks({}, adapter).bitl as Record<string, unknown[]>;
    expect(ours.Stop).toEqual([{ type: 'command', command: `node ${adapter} --source antigravity --event Stop`, timeout: 10 }]);
    expect(ours.PreToolUse).toEqual([{ matcher: '*', hooks: [{ type: 'command', command: `node ${adapter} --source antigravity --event PreToolUse`, timeout: 10 }] }]);
  });

  it('rejects paths with spaces (agy passes quotes through literally)', () => {
    expect(() => addAntigravityHooks({}, 'C:/Program Files/bitl/bitl-hook.mjs')).toThrow(/공백|spaces/);
  });
});

describe('Claude Desktop MCP config', () => {
  it('adds/removes while preserving other MCP servers', () => {
    const cfg = { mcpServers: { other: { command: 'x' } }, theme: 'dark' };
    const added = addMcpServer(cfg, 'C:/bitl/packages/adapters/bitl-mcp.mjs');
    expect(added.mcpServers).toEqual({
      other: { command: 'x' },
      bitl: { command: 'node', args: ['C:/bitl/packages/adapters/bitl-mcp.mjs', '--source', 'claude-desktop'] },
    });
    expect(removeMcpServer(added)).toEqual(cfg);
    expect(removeMcpServer(cfg)).toBe(cfg);
  });
});

describe('msixClaudeDir', () => {
  it('finds the Store install package folder, or undefined if absent', async () => {
    const { mkdirSync } = await import('node:fs');
    const { msixClaudeDir } = await import('../src/install.js');
    const local = mkdtempSync(join(tmpdir(), 'bitl-local-'));
    expect(msixClaudeDir(local)).toBeUndefined();
    const dir = join(local, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude');
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(local, 'Packages', 'Other_123'), { recursive: true });
    expect(msixClaudeDir(local)).toBe(dir);
  });
});
