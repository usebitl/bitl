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
  it('기존 설정과 다른 hook 을 보존하며 추가한다', () => {
    const out = addHooks({ theme: 'auto', hooks: { PreToolUse: [other] } }, cmd);
    expect(out.theme).toBe('auto');
    expect(Object.keys(out.hooks!)).toEqual(expect.arrayContaining([...CLAUDE_EVENTS]));
    expect(out.hooks!.PreToolUse).toEqual([other, { matcher: '*', hooks: [{ type: 'command', command: cmd, async: true, timeout: 10 }] }]);
  });

  it('여러 번 실행해도 중복되지 않는다', () => {
    const once = addHooks({}, cmd);
    expect(addHooks(once, cmd)).toEqual(once);
  });

  it('제거하면 우리 hook 만 빠지고 원래대로 돌아온다', () => {
    const original = { theme: 'auto', hooks: { PreToolUse: [other] } };
    expect(removeHooks(addHooks(original, cmd))).toEqual(original);
    expect(removeHooks(addHooks({ theme: 'auto' }, cmd))).toEqual({ theme: 'auto' });
  });

  it('원격 승인 hook 은 PermissionRequest 에만, 동기(async 아님)·긴 시간 제한으로', () => {
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
  it('백업을 남기고, 바뀐 게 없으면 쓰지 않는다', () => {
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

  it('파일이 없으면 새로 만든다', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'bitl-cli-')), '.claude', 'settings.json');
    expect(updateSettingsFile(file, (s) => addHooks(s, cmd))).toEqual({ changed: true, backup: undefined });
  });
});

describe('Codex config.toml 블록', () => {
  const codexCmd = hookCommand('codex', 'C:/bitl/packages/adapters/bitl-hook.mjs');
  const userToml = 'model = "gpt-5"\n\n[tui]\nnotifications = true\n';

  it('사용자 설정 뒤에 표식 블록을 붙이고, 제거하면 원래 텍스트로 돌아온다', () => {
    const added = addCodexBlock(userToml, codexCmd);
    expect(added.startsWith(userToml)).toBe(true);
    for (const e of CODEX_EVENTS) expect(added).toContain(`[[hooks.${e}.hooks]]`);
    expect(added).toContain(`command = 'node "C:/bitl/packages/adapters/bitl-hook.mjs" --source codex'`);
    expect(removeCodexBlock(added)).toBe(userToml);
  });

  it('여러 번 설치해도 블록은 하나', () => {
    const twice = addCodexBlock(addCodexBlock(userToml, codexCmd), codexCmd);
    expect(twice.split('# >>> bitl').length - 1).toBe(1);
    expect(twice).toBe(addCodexBlock(userToml, codexCmd));
  });

  it('빈 파일에도 설치/제거', () => {
    expect(removeCodexBlock(addCodexBlock('', codexCmd))).toBe('');
  });

  it('원격 승인 hook 은 넣지 않는다 (Codex 는 hook 이 답할 때까지 터미널 승인 창을 띄우지 않음)', () => {
    expect(addCodexBlock(userToml, codexCmd)).not.toContain('bitl-approve.mjs');
  });

  it('Codex 가 파일을 다시 써서 [hooks.state] 가 표식 블록 안에 들어가도 그것과 사용자 hook 은 남긴다', () => {
    const own = `[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = 'my-notify.exe'\n`;
    const state = `[hooks.state]\n[hooks.state.'C:\\\\Users\\\\me\\\\.codex\\\\config.toml:stop:0:0']\ntrusted_hash = "sha256:abc"\n`;
    // Codex 가 다시 쓴 모양: 끝 표식 앞에 신뢰 기록이 붙는다
    const rewritten = addCodexBlock(userToml + '\n' + own, codexCmd).replace('# <<< bitl <<<', state + '# <<< bitl <<<');
    const removed = removeCodexBlock(rewritten);
    expect(removed).not.toContain('bitl-hook.mjs');
    expect(removed).not.toContain('# >>> bitl');
    expect(removed).toContain(own);
    expect(removed).toContain(state);
    expect(removed.startsWith(userToml)).toBe(true);
    // 다시 설치해도 신뢰 기록·사용자 hook 은 그대로, 우리 표는 한 벌
    const again = addCodexBlock(rewritten, codexCmd);
    expect(again.split('bitl-hook.mjs').length - 1).toBe(CODEX_EVENTS.length);
    expect(again).toContain(state);
    expect(again).toContain(own);
  });

  it('SessionEnd·Interrupt 는 Codex 상한인 3초, 나머지는 10초', () => {
    const timeoutOf = (e: string) => addCodexBlock('', codexCmd).split(`[[hooks.${e}.hooks]]`)[1]?.match(/timeout = (\d+)/)?.[1];
    expect(timeoutOf('SessionEnd')).toBe('3');
    expect(timeoutOf('Interrupt')).toBe('3');
    expect(timeoutOf('Stop')).toBe('10');
  });
});

describe('Antigravity hooks.json', () => {
  const adapter = 'C:/bitl/packages/adapters/bitl-hook.mjs';
  const user = { 'my-hook': { enabled: true, Stop: [{ type: 'command', command: './x.sh' }] } };

  it('다른 hook 묶음을 보존하며 "bitl" 묶음만 추가/제거', () => {
    const added = addAntigravityHooks(user, adapter);
    expect(added['my-hook']).toEqual(user['my-hook']);
    const ours = added.bitl as Record<string, unknown>;
    for (const e of ANTIGRAVITY_EVENTS) expect(ours[e]).toBeDefined();
    expect(removeAntigravityHooks(added)).toEqual(user);
    expect(addAntigravityHooks(added, adapter)).toEqual(added);
  });

  it('따옴표 없이 경로, 이벤트 이름은 --event 로. 도구 이벤트만 matcher', () => {
    const ours = addAntigravityHooks({}, adapter).bitl as Record<string, unknown[]>;
    expect(ours.Stop).toEqual([{ type: 'command', command: `node ${adapter} --source antigravity --event Stop`, timeout: 10 }]);
    expect(ours.PreToolUse).toEqual([{ matcher: '*', hooks: [{ type: 'command', command: `node ${adapter} --source antigravity --event PreToolUse`, timeout: 10 }] }]);
  });

  it('공백이 있는 경로는 거부 (agy 가 따옴표를 그대로 넘긴다)', () => {
    expect(() => addAntigravityHooks({}, 'C:/Program Files/bitl/bitl-hook.mjs')).toThrow(/공백|spaces/);
  });
});

describe('Claude Desktop MCP 설정', () => {
  it('다른 MCP 서버를 보존하며 추가/제거', () => {
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
  it('스토어 설치 패키지 폴더를 찾고, 없으면 undefined', async () => {
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
