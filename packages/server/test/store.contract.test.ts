// Store contract: every DB must behave the same (DB list in databases.ts — SQLite, plus Postgres on the cloud side)
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionStore, StoreChange } from '../src/store/index.js';
import { CONTRACT_DATABASES, DATABASES } from './databases.js';
import { view, viewTurns, wire } from './helpers.js';

const backends = [...DATABASES, ...CONTRACT_DATABASES];

const AT = (sec: number) => new Date(Date.parse('2026-09-27T00:00:00Z') + sec * 1000).toISOString();
const hook = (sessionId: string, event: string, extra: Record<string, unknown> = {}, sec = 0) =>
  wire({ source: 'claude-code', receivedAt: AT(sec), payload: { session_id: sessionId, cwd: 'C:/w/api', hook_event_name: event, ...extra } });

describe.each(backends)('store contract — %s', (_name, open) => {
  let store: SessionStore;
  beforeEach(async () => {
    store = await open();
  });
  afterEach(() => store.close());

  it('ingest: session, turns, timeline', async () => {
    await store.ingest('a', await hook('s1', 'UserPromptSubmit', { prompt: '로그인 고쳐줘', prompt_id: 'p1' }, 1));
    await store.ingest('a', await hook('s1', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'pnpm test' }, prompt_id: 'p1' }, 2));
    await store.ingest('a', await hook('s1', 'PostToolUseFailure', { tool_name: 'Edit', tool_input: { file_path: 'a.ts' }, error_message: 'no' }, 3));
    await store.ingest('a', await hook('s1', 'Stop', { last_assistant_message: '끝', prompt_id: 'p1' }, 4));

    const s = await view(await store.getSession('a', 'claude-code:s1'));
    expect(s).toMatchObject({ status: 'needs_review', title: '로그인 고쳐줘', lastMessage: '끝', toolCount: 1, turnCount: 1 });
    expect(await viewTurns(await store.listTurns('a', 'claude-code:s1'))).toEqual([
      expect.objectContaining({ turnId: 'p1', prompt: '로그인 고쳐줘', result: '끝', status: 'done', toolCount: 1 }),
    ]);
    expect((await store.listTimeline('a', 'claude-code:s1')).map((t) => t.nativeType)).toEqual([
      'Stop',
      'PostToolUseFailure',
      'PreToolUse',
      'UserPromptSubmit',
    ]);
  });

  it('list: ended/archived filters, most recent activity first', async () => {
    await store.ingest('a', await hook('old', 'SessionStart', {}, 1));
    await store.ingest('a', await hook('new', 'SessionStart', {}, 2));
    await store.ingest('a', await hook('gone', 'SessionStart', {}, 3));
    await store.ingest('a', await hook('gone', 'SessionEnd', {}, 4));
    await store.editSession('a', 'claude-code:old', { archived: true });

    expect((await store.listSessions('a')).map((s) => s.key)).toEqual(['claude-code:new']);
    expect((await store.listSessions('a', { includeEnded: true, includeArchived: true })).map((s) => s.key)).toEqual([
      'claude-code:gone',
      'claude-code:new',
      'claude-code:old',
    ]);
  });

  it('edit, acknowledge, delete', async () => {
    await store.ingest('a', await hook('s1', 'UserPromptSubmit', { prompt: 'x' }, 1));
    await store.ingest('a', await hook('s1', 'Stop', {}, 2));
    expect((await store.editSession('a', 'claude-code:s1', { pinned: true }))?.pinned).toBe(true);
    expect((await store.acknowledge('a', 'claude-code:s1'))?.status).toBe('idle');
    expect(await store.editSession('a', 'nope', { pinned: true })).toBeUndefined();

    expect(await store.deleteSession('a', 'claude-code:s1')).toBe(true);
    expect(await store.getSession('a', 'claude-code:s1')).toBeUndefined();
    expect(await store.listTurns('a', 'claude-code:s1')).toHaveLength(0);
    expect(await store.listTimeline('a', 'claude-code:s1')).toHaveLength(0);
    expect(await store.deleteSession('a', 'claude-code:s1')).toBe(false);
  });

  it('stale check and old event pruning (all accounts)', async () => {
    await store.ingest('a', await hook('s1', 'UserPromptSubmit', { prompt: 'x' }, 1));
    await store.ingest('b', await hook('s1', 'UserPromptSubmit', { prompt: 'y' }, 1));
    const later = new Date(Date.parse(AT(1)) + 11 * 60_000);
    expect(await store.sweepStale(later)).toBe(2);
    expect((await store.getSession('b', 'claude-code:s1'))?.status).toBe('stale');
    expect(await store.sweepStale(later)).toBe(0);

    expect(await store.pruneEvents(new Date(AT(2)))).toBe(2);
    expect(await store.listTimeline('a', 'claude-code:s1')).toHaveLength(0);
    expect(await store.getSession('a', 'claude-code:s1')).toBeDefined(); // the session summary remains
  });

  describe('account isolation', () => {
    it('the same session key is separate per account — get, list, turns, timeline, edit, delete', async () => {
      await store.ingest('a', await hook('s1', 'UserPromptSubmit', { prompt: 'A 의 작업' }, 1));
      await store.ingest('b', await hook('s1', 'UserPromptSubmit', { prompt: 'B 의 작업' }, 2));
      await store.ingest('b', await hook('s1', 'Stop', {}, 3));

      expect((await view(await store.getSession('a', 'claude-code:s1')))?.title).toBe('A 의 작업');
      expect((await view(await store.getSession('b', 'claude-code:s1')))?.title).toBe('B 의 작업');
      expect((await store.getSession('a', 'claude-code:s1'))?.status).toBe('running');
      expect(await store.listSessions('c')).toHaveLength(0);
      expect(await store.listTurns('a', 'claude-code:s1')).toHaveLength(1);
      expect(await store.listTimeline('a', 'claude-code:s1')).toHaveLength(1);

      await store.editSession('b', 'claude-code:s1', { pinned: true });
      expect((await store.getSession('a', 'claude-code:s1'))?.pinned).toBeUndefined();
      await store.deleteSession('b', 'claude-code:s1');
      expect(await store.getSession('b', 'claude-code:s1')).toBeUndefined();
      expect(await store.getSession('a', 'claude-code:s1')).toBeDefined();
      expect(await store.listTimeline('a', 'claude-code:s1')).toHaveLength(1);
    });

    it('sessions of another account cannot be acknowledged, edited or deleted', async () => {
      await store.ingest('a', await hook('s1', 'Stop', {}, 1));
      expect(await store.acknowledge('b', 'claude-code:s1')).toBeUndefined();
      expect(await store.editSession('b', 'claude-code:s1', { archived: true })).toBeUndefined();
      expect(await store.deleteSession('b', 'claude-code:s1')).toBe(false);
      expect((await store.getSession('a', 'claude-code:s1'))?.archived).toBe(false);
    });

    it('change notifications carry the account', async () => {
      const seen: StoreChange[] = [];
      const off = store.subscribe((c) => seen.push(c));
      await store.ingest('a', await hook('s1', 'SessionStart', {}, 1));
      await store.deleteSession('a', 'claude-code:s1');
      off();
      expect(seen.map((c) => [c.type, c.accountId])).toEqual([
        ['session', 'a'],
        ['removed', 'a'],
      ]);
    });
  });

  it('loses nothing when events for the same session arrive concurrently', async () => {
    await store.ingest('a', await hook('s1', 'UserPromptSubmit', { prompt: 'x' }, 1));
    const tools = await Promise.all(
      Array.from({ length: 20 }, (_, i) => hook('s1', 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: `f${i}.ts` } }, 2 + i)),
    );
    await Promise.all(tools.map((r) => store.ingest('a', r)));
    const s = await store.getSession('a', 'claude-code:s1');
    expect(s?.toolCount).toBe(20);
    expect((await store.listTurns('a', 'claude-code:s1'))[0]?.toolCount).toBe(20);
  });
});
