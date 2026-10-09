import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { updateNotice } from '../src/update.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'bitl-update-'));
  vi.stubEnv('BITL_HOME', home);
  vi.stubEnv('BITL_LANG', 'en');
  vi.stubEnv('BITL_NO_UPDATE_CHECK', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

const registry = (version: string) => vi.fn(async () => new Response(JSON.stringify({ version })));

describe('새 버전 안내', () => {
  it('저장소에서 돌리면(버전 없음) 묻지 않는다', async () => {
    const f = registry('9.9.9');
    vi.stubGlobal('fetch', f);
    expect(await updateNotice(undefined)).toBeUndefined();
    expect(f).not.toHaveBeenCalled();
  });

  it('새 버전이 있으면 한 줄로 알리고, 하루 동안은 다시 묻지 않는다', async () => {
    const f = registry('0.1.5');
    vi.stubGlobal('fetch', f);
    expect(await updateNotice('0.1.4')).toContain('0.1.5');
    expect(await updateNotice('0.1.4')).toContain('0.1.5');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('최신이면 아무것도 없다', async () => {
    vi.stubGlobal('fetch', registry('0.1.4'));
    expect(await updateNotice('0.1.4')).toBeUndefined();
  });

  it('레지스트리에 닿지 못해도 명령을 막지 않는다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))));
    expect(await updateNotice('0.1.4')).toBeUndefined();
  });

  it('하루가 지나면 다시 묻는다', async () => {
    writeFileSync(join(home, 'update-check.json'), JSON.stringify({ checkedAt: '2020-01-01T00:00:00Z', latest: '0.1.4' }));
    const f = registry('0.2.0');
    vi.stubGlobal('fetch', f);
    expect(await updateNotice('0.1.4')).toContain('0.2.0');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('BITL_NO_UPDATE_CHECK=1 이면 끈다', async () => {
    vi.stubEnv('BITL_NO_UPDATE_CHECK', '1');
    const f = registry('9.9.9');
    vi.stubGlobal('fetch', f);
    expect(await updateNotice('0.1.4')).toBeUndefined();
    expect(f).not.toHaveBeenCalled();
  });
});
