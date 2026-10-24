import { describe, expect, it } from 'vitest';
import { deriveKeys, generateMasterKey, seal } from '../src/crypto.js';
import { displayTitle, type StoredSession } from '../src/session.js';
import { openSession, openTurn } from '../src/view.js';

const keys = await deriveKeys(generateMasterKey());
const other = await deriveKeys(generateMasterKey());
const KEY = 'claude-code:s1';

const stored = async (k = keys): Promise<StoredSession> => ({
  key: KEY,
  source: 'claude-code',
  sessionId: 's1',
  status: 'running',
  statusAt: '2026-09-27T00:00:00.000Z',
  turnCount: 1,
  toolCount: 0,
  subagentsRunning: 0,
  startedAt: '2026-09-27T00:00:00.000Z',
  lastEventAt: '2026-09-27T00:00:00.000Z',
  archived: false,
  lastPromptTag: 'tag',
  enc: { title: await seal(k, '로그인 고치기', KEY), project: await seal(k, 'api', KEY) },
});

describe('openSession', () => {
  it('with the right key: plaintext card, server-only values like tags are dropped', async () => {
    const s = await openSession(keys, await stored());
    expect(s).toMatchObject({ title: '로그인 고치기', project: 'api', status: 'running' });
    expect(s).not.toHaveProperty('enc');
    expect(s).not.toHaveProperty('lastPromptTag');
    expect(s.locked).toBeUndefined();
  });

  it('with another key or no key: content is empty and locked — status still shows', async () => {
    for (const k of [other, null]) {
      const s = await openSession(k, await stored());
      expect(s).toMatchObject({ status: 'running', locked: true });
      expect(s.title).toBeUndefined();
      expect(displayTitle(s)).toContain('🔒');
    }
  });

  it('ciphertext moved from another session does not open', async () => {
    const s = await stored();
    s.enc.title = await seal(keys, '다른 세션의 제목', 'claude-code:other');
    expect((await openSession(keys, s)).title).toBeUndefined();
  });
});

describe('openTurn', () => {
  it('turn', async () => {
    const t = await openTurn(keys, {
      sessionKey: KEY,
      prompt: await seal(keys, '지시', KEY),
      result: await seal(keys, '결과', KEY),
      status: 'done',
      startedAt: '2026-09-27T00:00:00.000Z',
      toolCount: 2,
    });
    expect(t).toMatchObject({ prompt: '지시', result: '결과', toolCount: 2 });
  });
});
