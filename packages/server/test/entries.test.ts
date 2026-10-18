import { deriveKeys, generateMasterKey, open as openSealed, seal } from '@bitl/shared/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { type Entry, EntryStore, type SqlStore } from '../src/store/index.js';
import { DATABASES } from './databases.js';

const keys = await deriveKeys(generateMasterKey());
const sealEntry = (id: string, text: string) => seal(keys, JSON.stringify({ kind: 'learned', text }), `entry:${id}`);

describe.each(DATABASES)('entries — %s', (_, open) => {
  let store: SqlStore;
  let entries: EntryStore;
  let app: ReturnType<typeof createApp>;
  let writable = true;
  const access = { canWrite: async () => writable };

  beforeEach(async () => {
    store = await open();
    entries = new EntryStore(store.db);
    writable = true;
    app = createApp({ store, entries, access, account: (c) => c.req.header('x-account') ?? null });
  });
  afterEach(() => store.close());

  const call = (account: string, method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { 'content-type': 'application/json', 'x-account': account },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const list = async (account: string, query = '') => (await (await call(account, 'GET', `/api/entries${query}`)).json()) as Entry[];

  it('writes and returns the sealed content as is — the server cannot read it; other accounts see nothing', async () => {
    const data = await sealEntry('entry_aaaaaaaa', 'Esc 중단은 hook 이 안 온다');
    const res = await call('u1', 'POST', '/api/entries', { id: 'entry_aaaaaaaa', data, sessionKey: 'claude-code:s1' });
    expect(res.status).toBe(201);
    const [e] = await list('u1');
    expect(e).toMatchObject({ id: 'entry_aaaaaaaa', sessionKey: 'claude-code:s1' });
    expect(JSON.parse(await openSealed(keys, e!.data, 'entry:entry_aaaaaaaa'))).toEqual({ kind: 'learned', text: 'Esc 중단은 hook 이 안 온다' });
    expect(await list('u2')).toEqual([]);
    expect((await call('u2', 'DELETE', '/api/entries/entry_aaaaaaaa')).status).toBe(404);
  });

  it('rejects plaintext, bad ids, bad card keys and duplicate ids', async () => {
    const data = await sealEntry('entry_aaaaaaaa', 'x');
    expect((await call('u1', 'POST', '/api/entries', { id: 'entry_aaaaaaaa', data: '평문 기록' })).status).toBe(400);
    expect((await call('u1', 'POST', '/api/entries', { id: 'x', data })).status).toBe(400);
    expect((await call('u1', 'POST', '/api/entries', { id: 'entry_aaaaaaaa', data, sessionKey: 42 })).status).toBe(400);
    expect((await call('u1', 'POST', '/api/entries', { id: 'entry_aaaaaaaa', data })).status).toBe(201);
    expect((await call('u1', 'POST', '/api/entries', { id: 'entry_aaaaaaaa', data })).status).toBe(409);
  });

  it("lists newest first, a card's own entries, and pages back by time", async () => {
    const at = (m: number) => `2026-10-18T00:0${m}:00.000Z`;
    for (const [i, key] of [[1, 'claude-code:s1'], [2, undefined], [3, 'claude-code:s1'], [4, 'codex:s2']] as const)
      await entries.create('u1', `entry_${i}_aaaaaa`, await sealEntry(`entry_${i}_aaaaaa`, `t${i}`), key, at(i));

    expect((await list('u1')).map((e) => e.id)).toEqual(['entry_4_aaaaaa', 'entry_3_aaaaaa', 'entry_2_aaaaaa', 'entry_1_aaaaaa']);
    expect((await list('u1', '?session=claude-code:s1')).map((e) => e.id)).toEqual(['entry_3_aaaaaa', 'entry_1_aaaaaa']);
    expect((await list('u1', `?before=${at(3)}&limit=1`)).map((e) => e.id)).toEqual(['entry_2_aaaaaa']);
    expect((await list('u1', `?since=${at(3)}`)).map((e) => e.id)).toEqual(['entry_4_aaaaaa', 'entry_3_aaaaaa']);
    expect((await call('u1', 'GET', '/api/entries?before=yesterday')).status).toBe(400);
  });

  it('rewriting keeps the time it was written; deleting removes it; changes are announced to the account', async () => {
    const seen: string[] = [];
    const off = entries.subscribe((c) => seen.push(`${c.accountId}:${c.type}`));
    await entries.create('u1', 'entry_aaaaaaaa', await sealEntry('entry_aaaaaaaa', 'first'), undefined, '2026-10-18T00:00:00.000Z');
    const res = await call('u1', 'PUT', '/api/entries/entry_aaaaaaaa', { data: await sealEntry('entry_aaaaaaaa', 'second') });
    expect(res.status).toBe(200);
    const e = (await res.json()) as Entry;
    expect(e.createdAt).toBe('2026-10-18T00:00:00.000Z');
    expect(e.updatedAt > e.createdAt).toBe(true);
    expect((await call('u1', 'PUT', '/api/entries/entry_nope_00', { data: await sealEntry('entry_nope_00', 'x') })).status).toBe(404);
    expect((await call('u1', 'DELETE', '/api/entries/entry_aaaaaaaa')).status).toBe(200);
    expect(await list('u1')).toEqual([]);
    off();
    expect(seen).toEqual(['u1:entry', 'u1:entry', 'u1:entry-removed']);
  });

  it('entries outlive their card: deleting or clearing cards leaves them', async () => {
    await entries.create('u1', 'entry_aaaaaaaa', await sealEntry('entry_aaaaaaaa', 'x'), 'claude-code:s1');
    await store.deleteSession('u1', 'claude-code:s1');
    await store.clearBoard('u1');
    expect(await list('u1')).toHaveLength(1);
  });

  it('read-only accounts get 402 on write/rewrite; read and delete still work', async () => {
    await call('u1', 'POST', '/api/entries', { id: 'entry_aaaaaaaa', data: await sealEntry('entry_aaaaaaaa', 'x') });
    writable = false;
    expect((await call('u1', 'POST', '/api/entries', { id: 'entry_bbbbbbbb', data: await sealEntry('entry_bbbbbbbb', 'y') })).status).toBe(402);
    expect((await call('u1', 'PUT', '/api/entries/entry_aaaaaaaa', { data: await sealEntry('entry_aaaaaaaa', 'z') })).status).toBe(402);
    expect(await list('u1')).toHaveLength(1);
    expect((await call('u1', 'DELETE', '/api/entries/entry_aaaaaaaa')).status).toBe(200);
  });
});
