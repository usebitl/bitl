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
  vi.stubEnv('BITL_INSTALL', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

const registry = (version: string) => vi.fn(async () => new Response(JSON.stringify({ version })));

describe('new-version notice', () => {
  it('does not query when run from the repo (no version)', async () => {
    const f = registry('9.9.9');
    vi.stubGlobal('fetch', f);
    expect(await updateNotice(undefined)).toBeUndefined();
    expect(f).not.toHaveBeenCalled();
  });

  it('announces a new version in one line and does not query again for a day', async () => {
    const f = registry('0.1.5');
    vi.stubGlobal('fetch', f);
    expect(await updateNotice('0.1.4')).toContain('0.1.5');
    expect(await updateNotice('0.1.4')).toContain('0.1.5');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('prints nothing when up to date', async () => {
    vi.stubGlobal('fetch', registry('0.1.4'));
    expect(await updateNotice('0.1.4')).toBeUndefined();
  });

  it('does not block the command when the registry is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))));
    expect(await updateNotice('0.1.4')).toBeUndefined();
  });

  it('queries again after a day', async () => {
    writeFileSync(join(home, 'update-check.json'), JSON.stringify({ checkedAt: '2020-01-01T00:00:00Z', latest: '0.1.4' }));
    const f = registry('0.2.0');
    vi.stubGlobal('fetch', f);
    expect(await updateNotice('0.1.4')).toContain('0.2.0');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('suggests the command matching how bitl was installed', async () => {
    vi.stubGlobal('fetch', registry('0.2.0'));
    expect(await updateNotice('0.1.4')).toContain('npm i -g @usebitl/cli');
    vi.stubEnv('BITL_INSTALL', 'npx');
    expect(await updateNotice('0.1.4')).toContain('npx @usebitl/cli@latest start');
  });

  it('is disabled by BITL_NO_UPDATE_CHECK=1', async () => {
    vi.stubEnv('BITL_NO_UPDATE_CHECK', '1');
    const f = registry('9.9.9');
    vi.stubGlobal('fetch', f);
    expect(await updateNotice('0.1.4')).toBeUndefined();
    expect(f).not.toHaveBeenCalled();
  });
});
