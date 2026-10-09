import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectName } from '../src/node/enrich.js';

describe('projectName', () => {
  it('git 저장소 하위 폴더에서도 저장소 최상위 폴더 이름', async () => {
    // 저장소를 clone 한 폴더 이름과 관계없이 돌도록 임시 저장소를 만든다
    const repo = mkdtempSync(join(tmpdir(), 'proj-'));
    execFileSync('git', ['init', '-q', repo]);
    const sub = join(repo, 'packages', 'web');
    mkdirSync(sub, { recursive: true });
    expect(await projectName(sub)).toBe(basename(repo));
    expect(await projectName(repo)).toBe(basename(repo));
  });

  it('git 저장소가 아니면 cwd 폴더 이름', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'not-a-repo-'));
    expect(await projectName(dir)).toMatch(/^not-a-repo-/);
  });
});
